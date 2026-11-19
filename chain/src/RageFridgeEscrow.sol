// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestCredit} from "./TestCredit.sol";

/// @notice Fuji-only, zero-fee escrow for nonredeemable TestCredit. No upgrade or sweep path.
contract RageFridgeEscrow {
    uint256 public constant FUJI_CHAIN_ID = 43113;
    uint256 public constant FUNDING_WINDOW = 120 seconds;
    uint256 public constant START_WINDOW = 60 seconds;
    uint256 public constant RESULT_WINDOW = 420 seconds;
    uint256 public constant INSPECTION_WINDOW = 120 seconds;
    uint256 public constant TERMINAL_TIMEOUT = 600 seconds;
    bytes32 public constant START_TYPEHASH = keccak256(
        "Start(bytes32 matchId,bytes32 rulesHash,bytes32 rosterHash,bytes32 roleCommitment,uint64 lockTimestamp,uint64 expiry)"
    );
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "Result(bytes32 matchId,bytes32 rulesHash,bytes32 rosterHash,uint64 startTimestamp,uint8 outcome,bytes32 roleSeed,bytes32 merkleRoot,uint256[4] payouts,uint256 fee,uint64 expiry)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum State {
        NONE,
        FUNDING,
        LOCKED,
        ACTIVE,
        RESULT_PENDING,
        SETTLED,
        REFUNDABLE
    }
    enum Outcome {
        COLD,
        SABOTEUR,
        REFUND
    }
    enum Role {
        CHEF,
        SABOTEUR,
        STOIC
    }

    struct Match {
        State state;
        uint64 createdAt;
        uint64 lockAt;
        uint64 startAt;
        uint64 inspectionEnds;
        uint256 stake;
        bytes32 rulesHash;
        bytes32 rosterHash;
        bytes32 roleCommitment;
        address[4] recipients;
        uint8 deposited;
        uint8 ready;
        uint8 claimed;
        Outcome outcome;
        bytes32 resultFingerprint;
        uint256[4] payouts;
    }

    struct Result {
        bytes32 matchId;
        bytes32 rulesHash;
        bytes32 rosterHash;
        uint64 startTimestamp;
        Outcome outcome;
        bytes32 roleSeed;
        bytes32 merkleRoot;
        uint256[4] payouts;
        uint256 fee;
        uint64 expiry;
    }

    TestCredit public immutable token;
    address public immutable creator;
    address[3] public signers;
    uint256 public liability;
    mapping(bytes32 => Match) private matches;
    bool private transferring;

    error WrongChain();
    error InvalidConfig();
    error InvalidState();
    error Deadline();
    error InvalidAmount();
    error TransferFailed();
    error InvalidResult();
    error InvalidSignatures();
    error DuplicateSigner();
    error MalleableSignature();
    error AlreadyClaimed();
    error NotRecipient();
    error Reentrancy();

    event StateChanged(bytes32 indexed matchId, State state);
    event Deposited(bytes32 indexed matchId, address indexed account, uint256 amount);
    event Ready(bytes32 indexed matchId, address indexed account);
    event ResultProposed(bytes32 indexed matchId, bytes32 digest, bytes32 merkleRoot, Outcome outcome);
    event ResultConflict(bytes32 indexed matchId, bytes32 conflictingDigest);
    event Claimed(bytes32 indexed matchId, address indexed account, uint256 amount);

    modifier fuji() {
        if (block.chainid != FUJI_CHAIN_ID) revert WrongChain();
        _;
    }
    modifier nonReentrant() {
        if (transferring) revert Reentrancy();
        transferring = true;
        _;
        transferring = false;
    }

    /// @dev Single allowlisted asset; pin the deployed TestCredit bytecode in any future configuration.
    constructor(TestCredit token_, address[3] memory signers_) fuji {
        if (address(token_).codehash != keccak256(type(TestCredit).runtimeCode)) revert InvalidConfig();
        for (uint256 i; i < 3; ++i) {
            if (signers_[i] == address(0)) revert InvalidConfig();
            for (uint256 j; j < i; ++j) {
                if (signers_[i] == signers_[j]) revert InvalidConfig();
            }
        }
        signers = signers_;
        token = token_;
        creator = msg.sender;
    }

    function createMatch(
        bytes32 matchId,
        address[4] calldata recipients,
        uint256 stake,
        bytes32 rulesHash,
        bytes32 roleCommitment
    ) external fuji {
        Match storage m = matches[matchId];
        if (
            msg.sender != creator || m.state != State.NONE || matchId == 0 || rulesHash == 0 || roleCommitment == 0
                || stake == 0 || stake > type(uint256).max / 4
        ) revert InvalidConfig();
        for (uint256 i; i < 4; ++i) {
            if (recipients[i] == address(0) || recipients[i] == address(this)) revert InvalidConfig();
            for (uint256 j; j < i; ++j) {
                if (recipients[i] == recipients[j]) revert InvalidConfig();
            }
        }
        m.createdAt = uint64(block.timestamp);
        m.stake = stake;
        m.rulesHash = rulesHash;
        m.rosterHash = keccak256(abi.encode(recipients));
        m.roleCommitment = roleCommitment;
        m.recipients = recipients;
        _transition(m, matchId, State.FUNDING);
    }

    function joinAndDeposit(bytes32 matchId, uint256 amount) external fuji nonReentrant {
        Match storage m = matches[matchId];
        _funding(m);
        uint8 bit = _seat(m, msg.sender);
        if (amount != m.stake || m.deposited & bit != 0 || token.allowance(msg.sender, address(this)) != amount) {
            revert InvalidAmount();
        }
        uint256 beforeBalance = token.balanceOf(address(this));
        m.deposited |= bit;
        liability += amount;
        if (
            !token.transferFrom(msg.sender, address(this), amount)
                || token.balanceOf(address(this)) != beforeBalance + amount
                || token.allowance(msg.sender, address(this)) != 0
        ) revert TransferFailed();
        emit Deposited(matchId, msg.sender, amount);
    }

    function setReady(bytes32 matchId) external fuji {
        Match storage m = matches[matchId];
        _funding(m);
        uint8 bit = _seat(m, msg.sender);
        if (m.deposited & bit == 0) revert InvalidState();
        m.ready |= bit;
        emit Ready(matchId, msg.sender);
    }

    function lockMatch(bytes32 matchId) external fuji {
        Match storage m = matches[matchId];
        _funding(m);
        if (m.deposited != 15 || m.ready != 15) revert InvalidState();
        m.lockAt = uint64(block.timestamp);
        _transition(m, matchId, State.LOCKED);
    }

    function startDigest(bytes32 matchId, uint64 expiry) public view returns (bytes32) {
        Match storage m = matches[matchId];
        return _typed(
            keccak256(
                abi.encode(START_TYPEHASH, matchId, m.rulesHash, m.rosterHash, m.roleCommitment, m.lockAt, expiry)
            )
        );
    }

    function startMatch(bytes32 matchId, uint64 expiry, bytes[2] calldata signatures) external fuji {
        Match storage m = matches[matchId];
        if (m.state != State.LOCKED) revert InvalidState();
        if (block.timestamp >= m.lockAt + START_WINDOW || block.timestamp >= expiry) revert Deadline();
        _checkQuorum(startDigest(matchId, expiry), signatures);
        m.startAt = uint64(block.timestamp);
        _transition(m, matchId, State.ACTIVE);
    }

    function submitResult(Result calldata r, bytes[2] calldata signatures) external fuji {
        Match storage m = matches[r.matchId];
        bool pending = m.state == State.RESULT_PENDING;
        if (!pending && m.state != State.ACTIVE) revert InvalidState();
        if (block.timestamp >= r.expiry || block.timestamp >= (pending ? m.inspectionEnds : m.startAt + RESULT_WINDOW))
        {
            revert Deadline();
        }
        _validateResult(m, r);
        bytes32 digest = resultDigest(r);
        _checkQuorum(digest, signatures);
        // Different expiry or signers alone cannot invalidate an otherwise identical result.
        bytes32 fingerprint = _resultHash(r, 0);
        if (pending) {
            if (m.resultFingerprint == fingerprint) revert InvalidResult();
            emit ResultConflict(r.matchId, digest);
            _transition(m, r.matchId, State.REFUNDABLE);
            return;
        }
        m.resultFingerprint = fingerprint;
        m.outcome = r.outcome;
        m.payouts = r.payouts;
        m.inspectionEnds = uint64(block.timestamp + INSPECTION_WINDOW);
        emit ResultProposed(r.matchId, digest, r.merkleRoot, r.outcome);
        _transition(m, r.matchId, State.RESULT_PENDING);
    }

    function finalize(bytes32 matchId) external fuji {
        Match storage m = matches[matchId];
        if (m.state != State.RESULT_PENDING) revert InvalidState();
        if (block.timestamp < m.inspectionEnds || block.timestamp >= m.startAt + TERMINAL_TIMEOUT) revert Deadline();
        _transition(m, matchId, m.outcome == Outcome.REFUND ? State.REFUNDABLE : State.SETTLED);
    }

    function timeout(bytes32 matchId) external fuji {
        Match storage m = matches[matchId];
        uint256 deadline;
        if (m.state == State.FUNDING) deadline = m.createdAt + FUNDING_WINDOW;
        else if (m.state == State.LOCKED) deadline = m.lockAt + START_WINDOW;
        else if (m.state == State.ACTIVE) deadline = m.startAt + RESULT_WINDOW;
        else if (m.state == State.RESULT_PENDING) deadline = m.startAt + TERMINAL_TIMEOUT;
        else revert InvalidState();
        if (block.timestamp < deadline) revert Deadline();
        _transition(m, matchId, State.REFUNDABLE);
    }

    function claimPayout(bytes32 matchId) external fuji nonReentrant returns (uint256 amount) {
        Match storage m = matches[matchId];
        if (m.state != State.SETTLED && m.state != State.REFUNDABLE) revert InvalidState();
        uint8 bit = _seat(m, msg.sender);
        if (m.claimed & bit != 0) revert AlreadyClaimed();
        if (m.state == State.REFUNDABLE) {
            amount = m.deposited & bit != 0 ? m.stake : 0;
        } else {
            for (uint256 i; i < 4; ++i) {
                if (bit == 1 << i) amount = m.payouts[i];
            }
        }
        m.claimed |= bit;
        liability -= amount;
        if (amount != 0) {
            uint256 beforeEscrow = token.balanceOf(address(this));
            uint256 beforeRecipient = token.balanceOf(msg.sender);
            if (
                !token.transfer(msg.sender, amount) || token.balanceOf(address(this)) != beforeEscrow - amount
                    || token.balanceOf(msg.sender) != beforeRecipient + amount
            ) revert TransferFailed();
        }
        emit Claimed(matchId, msg.sender, amount);
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function depositedFor(bytes32 matchId, address account) external view returns (uint256) {
        Match storage m = matches[matchId];
        for (uint256 i; i < 4; ++i) {
            if (m.recipients[i] == account && m.deposited & (1 << i) != 0) return m.stake;
        }
        return 0;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("RageFridgeEscrow"), keccak256("1"), FUJI_CHAIN_ID, address(this))
        );
    }

    function resultDigest(Result calldata result) public view returns (bytes32) {
        return _typed(_resultHash(result, result.expiry));
    }

    function rolesFor(bytes32 matchId, bytes32 roleSeed) public pure returns (Role[4] memory roles) {
        roles = [Role.CHEF, Role.CHEF, Role.SABOTEUR, Role.STOIC];
        for (uint256 i = 3; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode("RageFridge roles v1", matchId, roleSeed, i))) % (i + 1);
            (roles[i], roles[j]) = (roles[j], roles[i]);
        }
    }

    function _validateResult(Match storage m, Result calldata r) private view {
        if (
            r.startTimestamp != m.startAt || r.rulesHash != m.rulesHash || r.rosterHash != m.rosterHash || r.fee != 0
                || r.merkleRoot == 0 || keccak256(abi.encode(r.matchId, r.roleSeed)) != m.roleCommitment
        ) revert InvalidResult();
        uint256 pool = 4 * m.stake;
        uint256 remaining = pool;
        Role[4] memory roles = rolesFor(r.matchId, r.roleSeed);
        for (uint256 i; i < 4; ++i) {
            uint256 amount = r.payouts[i];
            if (amount > remaining) revert InvalidResult();
            remaining -= amount;
            if (r.outcome == Outcome.REFUND && amount != m.stake) revert InvalidResult();
            if (r.outcome == Outcome.COLD && roles[i] == Role.SABOTEUR && amount != 0) revert InvalidResult();
            if (r.outcome == Outcome.SABOTEUR && amount != (roles[i] == Role.SABOTEUR ? pool : 0)) {
                revert InvalidResult();
            }
        }
        if (remaining != 0) revert InvalidResult();
    }

    function _resultHash(Result calldata r, uint64 expiry) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RESULT_TYPEHASH,
                r.matchId,
                r.rulesHash,
                r.rosterHash,
                r.startTimestamp,
                r.outcome,
                r.roleSeed,
                r.merkleRoot,
                keccak256(abi.encode(r.payouts)),
                r.fee,
                expiry
            )
        );
    }

    function _typed(bytes32 hash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), hash));
    }

    function _checkQuorum(bytes32 digest, bytes[2] calldata signatures) private view {
        address a = _recover(digest, signatures[0]);
        address b = _recover(digest, signatures[1]);
        if (a == b) revert DuplicateSigner();
        if (!_isSigner(a) || !_isSigner(b)) revert InvalidSignatures();
    }

    function _isSigner(address signer) private view returns (bool) {
        return signer == signers[0] || signer == signers[1] || signer == signers[2];
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignatures();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert MalleableSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignatures();
    }

    function _funding(Match storage m) private view {
        if (m.state != State.FUNDING) revert InvalidState();
        if (block.timestamp >= m.createdAt + FUNDING_WINDOW) revert Deadline();
    }

    function _seat(Match storage m, address account) private view returns (uint8) {
        for (uint256 i; i < 4; ++i) {
            if (m.recipients[i] == account) return uint8(1 << i);
        }
        revert NotRecipient();
    }

    function _transition(Match storage m, bytes32 matchId, State state) private {
        m.state = state;
        emit StateChanged(matchId, state);
    }
}
