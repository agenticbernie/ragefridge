// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RageFridgeEscrow} from "./RageFridgeEscrow.sol";
import {TestCredit} from "./TestCredit.sol";

/// @notice Local reference policy only. Not a wallet, execution codec, validator, or paymaster.
/// @dev The audited stack adapter must derive and authenticate all decoded calls and state from the
/// actual UserOperation and pinned contracts. Never accept caller-provided policy facts as authority.
library RageFridge4337Policy {
    uint256 internal constant FUJI_CHAIN_ID = 43113;
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    uint256 internal constant SESSION_LIFETIME = 1800;

    enum Execution {
        UNKNOWN,
        SINGLE_CALL,
        ATOMIC_BATCH
    }
    enum Purpose {
        OWNER_ENTRY,
        OWNER_CLAIM,
        SESSION
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Rules {
        address escrow;
        address token;
        address account;
        bytes32 matchId;
        uint256 stake;
    }

    struct Session {
        bytes32 nonce;
        uint48 issuedAt;
        uint48 validUntil;
        bool revoked;
    }

    struct Context {
        address sender;
        bytes32 activeSessionNonce;
        uint256 nowSeconds;
        uint256 deposited;
    }

    struct Deployment {
        address account;
        address factory;
        bytes32 factoryDataHash;
        bytes32 accountCodeHash;
        bytes32 accountConfigHash;
    }

    struct Envelope {
        uint256 chainId;
        address entryPoint;
        address sender;
        // Presence flags; even an explicitly empty/null EIP-7702 field must be rejected.
        bool hasAuthorizationList;
        bool hasEip7702Auth;
        bool delegatedOrFallback;
        bytes initCode;
        bytes senderCode;
        // Hash of verified implementation, validator modules and account configuration, not just proxy code.
        bytes32 verifiedAccountConfigHash;
    }

    // eth-infinitism v0.7 PackedUserOperation. Only scheme-independent fields are modeled here.
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    struct SponsorRules {
        address paymaster;
        uint48 validAfter;
        uint48 validUntil;
        uint128 maxVerificationGas;
        uint128 maxCallGas;
        uint256 maxPreVerificationGas;
        uint128 maxPriorityFee;
        uint128 maxFee;
        uint128 maxPaymasterVerificationGas;
        uint128 maxPostOpGas;
    }

    error ForbiddenEnvelope();
    error DeploymentMismatch();
    error ForbiddenExecution();
    error ForbiddenCall();
    error SessionInactive();
    error SpendCapExceeded();
    error SponsorshipDenied();

    function validateEnvelope(Envelope calldata op, Deployment memory pin) internal pure {
        if (
            op.chainId != FUJI_CHAIN_ID || op.entryPoint != ENTRY_POINT_V07 || op.hasAuthorizationList
                || op.hasEip7702Auth || op.delegatedOrFallback
                || (op.senderCode.length >= 3 && bytes3(op.senderCode[:3]) == 0xef0100)
                || (op.initCode.length >= 2 && bytes2(op.initCode[:2]) == 0x7702)
        ) revert ForbiddenEnvelope();
        if (
            pin.account == address(0) || op.sender != pin.account || pin.factory == address(0)
                || pin.accountCodeHash == 0 || pin.accountConfigHash == 0
                || op.verifiedAccountConfigHash != pin.accountConfigHash
        ) revert DeploymentMismatch();
        if (op.senderCode.length == 0) {
            if (
                op.initCode.length <= 20 || address(bytes20(op.initCode[:20])) != pin.factory
                    || keccak256(op.initCode[20:]) != pin.factoryDataHash
            ) revert DeploymentMismatch();
        } else if (op.initCode.length != 0 || keccak256(op.senderCode) != pin.accountCodeHash) {
            revert DeploymentMismatch();
        }
    }

    /// @param policyInstall Full expected calldata from the PINNED adapter for exactly this policy/session.
    /// @param allowance Pre-operation ERC-20 allowance read from the pinned test token.
    function validateOwnerEntry(
        Rules memory rules,
        Execution mode,
        Call[] calldata calls,
        bytes memory policyInstall,
        uint256 allowance,
        uint256 deposited
    ) internal pure {
        _checkRules(rules);
        if (
            mode != Execution.ATOMIC_BATCH || calls.length != 4 || policyInstall.length < 4 || allowance != 0
                || deposited != 0
        ) {
            revert ForbiddenExecution();
        }
        _exact(calls[0], rules.account, policyInstall);
        _exact(calls[1], rules.token, abi.encodeCall(TestCredit.approve, (rules.escrow, rules.stake)));
        _exact(calls[2], rules.escrow, abi.encodeCall(RageFridgeEscrow.joinAndDeposit, (rules.matchId, rules.stake)));
        _exact(calls[3], rules.escrow, abi.encodeCall(RageFridgeEscrow.setReady, (rules.matchId)));
    }

    /// @notice Owner recovery after session loss/expiry has only the normal fixed-recipient claim call.
    function validateOwnerClaim(Rules memory rules, Execution mode, Call[] calldata calls) internal pure {
        _checkRules(rules);
        if (mode != Execution.SINGLE_CALL || calls.length != 1) revert ForbiddenExecution();
        _exact(calls[0], rules.escrow, abi.encodeCall(RageFridgeEscrow.claimPayout, (rules.matchId)));
    }

    /// @param ctx The adapter reads `depositedFor(matchId, sender)` again before execution; state is never a UI hint.
    /// @dev An actual session originates only from owner entry, meaning deposited is already stake and spend left is zero.
    function validateSession(
        Rules memory rules,
        Session memory session,
        Context memory ctx,
        Execution mode,
        Call[] calldata calls
    ) internal pure returns (uint256 spent) {
        _checkRules(rules);
        if (
            session.revoked || ctx.sender != rules.account || session.nonce == 0
                || session.nonce != ctx.activeSessionNonce
                || uint256(session.validUntil) != uint256(session.issuedAt) + SESSION_LIFETIME
                || ctx.nowSeconds < session.issuedAt || ctx.nowSeconds >= session.validUntil
        ) revert SessionInactive();
        if (!((mode == Execution.SINGLE_CALL && calls.length == 1)
                    || (mode == Execution.ATOMIC_BATCH && calls.length > 0 && calls.length <= 3))) {
            revert ForbiddenExecution();
        }
        if (ctx.deposited > rules.stake) revert SpendCapExceeded();
        for (uint256 i; i < calls.length; ++i) {
            Call calldata call = calls[i];
            if (call.target != rules.escrow || call.value != 0 || call.data.length < 4) revert ForbiddenCall();
            bytes4 selector = bytes4(call.data[:4]);
            if (selector == RageFridgeEscrow.joinAndDeposit.selector) {
                // Escrow permits only a one-shot exact-S deposit; reject cross-match and trailing data.
                _exact(
                    call, rules.escrow, abi.encodeCall(RageFridgeEscrow.joinAndDeposit, (rules.matchId, rules.stake))
                );
                if (rules.stake > rules.stake - ctx.deposited - spent) revert SpendCapExceeded();
                spent += rules.stake;
            } else if (selector == RageFridgeEscrow.setReady.selector) {
                _exact(call, rules.escrow, abi.encodeCall(RageFridgeEscrow.setReady, (rules.matchId)));
            } else if (selector == RageFridgeEscrow.claimPayout.selector) {
                _exact(call, rules.escrow, abi.encodeCall(RageFridgeEscrow.claimPayout, (rules.matchId)));
            } else {
                revert ForbiddenCall();
            }
        }
    }

    /// @notice Authorizes nothing by itself. Compute ONLY after envelope and authenticated decode/purpose checks.
    /// @dev Future scheme must independently verify this intent or equivalent bindings on-chain. `paymasterAndData`
    /// suffix and account signature are scheme-owned and deliberately excluded to avoid circular signature hashes.
    /// `decodedPolicyHash` must commit to authorized purpose, decoded calls and the pinned stack/policy, not caller text.
    function sponsorIntent(
        PackedUserOperation calldata op,
        SponsorRules memory sponsor,
        Purpose purpose,
        bytes32 decodedPolicyHash,
        uint256 nowSeconds
    ) internal pure returns (bytes32) {
        if (
            op.sender == address(0) || op.callData.length == 0 || sponsor.paymaster == address(0)
                || decodedPolicyHash == 0 || nowSeconds < sponsor.validAfter || nowSeconds >= sponsor.validUntil
                || op.paymasterAndData.length < 52 || address(bytes20(op.paymasterAndData[:20])) != sponsor.paymaster
        ) revert SponsorshipDenied();
        uint128 paymasterValidation = uint128(bytes16(op.paymasterAndData[20:36]));
        uint128 postOp = uint128(bytes16(op.paymasterAndData[36:52]));
        _gasBounds(op, sponsor, paymasterValidation, postOp);
        bytes32 fields = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                paymasterValidation,
                postOp
            )
        );
        return keccak256(
            abi.encode(
                keccak256("RageFridge.sponsorship.v1"),
                FUJI_CHAIN_ID,
                ENTRY_POINT_V07,
                sponsor,
                purpose,
                decodedPolicyHash,
                fields
            )
        );
    }

    function _gasBounds(
        PackedUserOperation calldata op,
        SponsorRules memory sponsor,
        uint128 paymasterValidation,
        uint128 postOp
    ) private pure {
        (uint128 verification, uint128 execution) = unpack(op.accountGasLimits);
        (uint128 priority, uint128 maxFee) = unpack(op.gasFees);
        if (
            verification == 0 || execution == 0 || op.preVerificationGas == 0 || maxFee == 0 || paymasterValidation == 0
                || verification > sponsor.maxVerificationGas || execution > sponsor.maxCallGas || priority > maxFee
                || priority > sponsor.maxPriorityFee || maxFee > sponsor.maxFee
                || op.preVerificationGas > sponsor.maxPreVerificationGas
                || paymasterValidation > sponsor.maxPaymasterVerificationGas || postOp > sponsor.maxPostOpGas
        ) revert SponsorshipDenied();
    }

    function pack(uint128 hi, uint128 lo) internal pure returns (bytes32) {
        return bytes32((uint256(hi) << 128) | lo);
    }

    function unpack(bytes32 word) internal pure returns (uint128 hi, uint128 lo) {
        return (uint128(uint256(word) >> 128), uint128(uint256(word)));
    }

    function _checkRules(Rules memory rules) private pure {
        if (
            rules.escrow == address(0) || rules.token == address(0) || rules.account == address(0) || rules.matchId == 0
                || rules.stake == 0 || rules.escrow == rules.token || rules.escrow == rules.account
                || rules.token == rules.account
        ) {
            revert ForbiddenCall();
        }
    }

    function _exact(Call calldata call, address target, bytes memory data) private pure {
        if (call.target != target || call.value != 0 || keccak256(call.data) != keccak256(data)) {
            revert ForbiddenCall();
        }
    }
}
