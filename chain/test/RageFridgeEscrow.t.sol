// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {TestCredit} from "../src/TestCredit.sol";
import {RageFridgeEscrow as Escrow} from "../src/RageFridgeEscrow.sol";

contract RageFridgeEscrowTest is TestBase {
    // Public Foundry-only simulation fixtures, not credentials.
    uint256 constant SIGNER_A = 11;
    uint256 constant SIGNER_B = 12;
    uint256 constant SIGNER_C = 13;
    uint256 constant STAKE = 1000;
    bytes32 constant ID = keccak256("match-1");
    bytes32 constant RULES = keccak256("rules-v1");
    bytes32 constant SEED = keccak256("role-seed");

    TestCredit token;
    Escrow escrow;
    address[4] seats = [address(101), address(102), address(103), address(104)];
    address[3] signerSet;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(1000);
        signerSet = [vm.addr(SIGNER_A), vm.addr(SIGNER_B), vm.addr(SIGNER_C)];
        token = new TestCredit();
        escrow = new Escrow(token, signerSet);
        _create(escrow, ID);
    }

    function _create(Escrow target, bytes32 id) internal {
        target.createMatch(id, seats, STAKE, RULES, keccak256(abi.encode(id, SEED)));
    }

    function _deposit(Escrow target, bytes32 id, address account) internal {
        token.mint(account, STAKE);
        vm.prank(account);
        token.approve(address(target), STAKE);
        vm.prank(account);
        target.joinAndDeposit(id, STAKE);
        assertEq(token.allowance(account, address(target)), 0);
        vm.prank(account);
        target.setReady(id);
    }

    function _lock(Escrow target, bytes32 id) internal {
        for (uint256 i; i < 4; ++i) {
            _deposit(target, id, seats[i]);
        }
        target.lockMatch(id);
    }

    function _start(Escrow target, bytes32 id) internal {
        _lock(target, id);
        uint64 expiry = uint64(block.timestamp + 60);
        target.startMatch(id, expiry, _signed(target.startDigest(id, expiry), SIGNER_A, SIGNER_C));
    }

    function _result(Escrow target, bytes32 id, Escrow.Outcome outcome) internal view returns (Escrow.Result memory r) {
        Escrow.Match memory m = target.getMatch(id);
        r = Escrow.Result(
            id,
            RULES,
            m.rosterHash,
            m.startAt,
            outcome,
            SEED,
            keccak256("log root"),
            [uint256(0), uint256(0), uint256(0), uint256(0)],
            0,
            m.startAt + 600
        );
        Escrow.Role[4] memory roles = target.rolesFor(id, SEED);
        for (uint256 i; i < 4; ++i) {
            if (outcome == Escrow.Outcome.REFUND) r.payouts[i] = STAKE;
            if (outcome == Escrow.Outcome.SABOTEUR && roles[i] == Escrow.Role.SABOTEUR) r.payouts[i] = STAKE * 4;
            if (outcome == Escrow.Outcome.COLD && roles[i] == Escrow.Role.STOIC) r.payouts[i] = STAKE * 4;
        }
    }

    function _signed(bytes32 digest, uint256 first, uint256 second) internal returns (bytes[2] memory signatures) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(first, digest);
        signatures[0] = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(second, digest);
        signatures[1] = abi.encodePacked(r, s, v);
    }

    function _submit(Escrow.Result memory r) internal {
        escrow.submitResult(r, _signed(escrow.resultDigest(r), SIGNER_A, SIGNER_B));
    }

    function _claimAll(bytes32 id, uint256[4] memory amounts) internal {
        for (uint256 i; i < 4; ++i) {
            vm.prank(seats[i]);
            assertEq(escrow.claimPayout(id), amounts[i]);
            assertEq(token.balanceOf(seats[i]), amounts[i]);
            vm.expectRevert(Escrow.AlreadyClaimed.selector);
            vm.prank(seats[i]);
            escrow.claimPayout(id);
        }
        assertEq(escrow.liability(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testEip712QuorumMerkleAndConservation() public {
        _start(escrow, ID);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.COLD);
        bytes[2] memory valid = _signed(escrow.resultDigest(r), SIGNER_A, SIGNER_B);
        r.merkleRoot = keccak256("mutated");
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        escrow.submitResult(r, valid);
        _submit(r);
        vm.expectRevert(Escrow.InvalidState.selector);
        vm.prank(seats[0]);
        escrow.claimPayout(ID);
        vm.expectRevert(Escrow.Deadline.selector);
        escrow.finalize(ID);
        vm.warp(1120);
        escrow.finalize(ID);
        _claimAll(ID, r.payouts);
        vm.expectRevert(Escrow.InvalidState.selector);
        escrow.timeout(ID);
    }

    function testInvalidDuplicateAndMalleableSignatures() public {
        _start(escrow, ID);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.SABOTEUR);
        bytes32 digest = escrow.resultDigest(r);
        bytes[2] memory signatures = _signed(digest, SIGNER_A, SIGNER_A);
        vm.expectRevert(Escrow.DuplicateSigner.selector);
        escrow.submitResult(r, signatures);
        signatures = _signed(digest, SIGNER_B, 14);
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        escrow.submitResult(r, signatures);
        signatures[0] = hex"0001";
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        escrow.submitResult(r, signatures);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(SIGNER_A, digest);
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        signatures[0] = abi.encodePacked(rr, bytes32(order - uint256(ss)), uint8(55 - v));
        vm.expectRevert(Escrow.MalleableSignature.selector);
        escrow.submitResult(r, signatures);
    }

    function testResultCannotReplayOnOtherMatchContractOrChain() public {
        _start(escrow, ID);
        Escrow other = new Escrow(token, signerSet);
        _create(other, ID);
        _start(other, ID);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.REFUND);
        bytes[2] memory signatures = _signed(escrow.resultDigest(r), SIGNER_A, SIGNER_B);
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        other.submitResult(r, signatures);
        bytes32 next = keccak256("other room");
        _create(escrow, next);
        _start(escrow, next);
        r.matchId = next;
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        escrow.submitResult(r, signatures);
        vm.chainId(1);
        vm.expectRevert(Escrow.WrongChain.selector);
        escrow.submitResult(r, signatures);
        vm.expectRevert(Escrow.WrongChain.selector);
        new Escrow(token, signerSet);
    }

    function testRejectsBadRoleSeedFeeAndOverAllocation() public {
        _start(escrow, ID);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.REFUND);
        bytes[2] memory empty;
        r.roleSeed = keccak256("replacement role seed");
        vm.expectRevert(Escrow.InvalidResult.selector);
        escrow.submitResult(r, empty);
        r.roleSeed = SEED;
        r.fee = 1;
        vm.expectRevert(Escrow.InvalidResult.selector);
        escrow.submitResult(r, empty);
        r.fee = 0;
        r.payouts[1] = type(uint256).max;
        vm.expectRevert(Escrow.InvalidResult.selector);
        escrow.submitResult(r, empty);
    }

    function testConflictingAttestationsRefundButExpiryChangeDoesNot() public {
        _start(escrow, ID);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.SABOTEUR);
        _submit(r);
        ++r.expiry;
        bytes[2] memory signatures = _signed(escrow.resultDigest(r), SIGNER_C, SIGNER_B);
        vm.expectRevert(Escrow.InvalidResult.selector);
        escrow.submitResult(r, signatures);
        r.merkleRoot = keccak256("conflicting log");
        _submit(r);
        _claimAll(ID, [STAKE, STAKE, STAKE, STAKE]);
    }

    function testRefundResultWaitsUntilFinalization() public {
        _start(escrow, ID);
        _submit(_result(escrow, ID, Escrow.Outcome.REFUND));
        vm.warp(1120);
        escrow.finalize(ID);
        assertEq(uint256(escrow.getMatch(ID).state), uint256(Escrow.State.REFUNDABLE));
        _claimAll(ID, [STAKE, STAKE, STAKE, STAKE]);
    }

    function testFundingTimeoutRefundsOnlyDepositor() public {
        _deposit(escrow, ID, seats[0]);
        vm.warp(1120);
        escrow.timeout(ID);
        _claimAll(ID, [STAKE, uint256(0), uint256(0), uint256(0)]);
    }

    function testExpiredStartAndMissingResultTimeouts() public {
        _lock(escrow, ID);
        bytes[2] memory empty;
        vm.expectRevert(Escrow.InvalidSignatures.selector);
        escrow.startMatch(ID, 1060, empty);
        vm.warp(1060);
        vm.expectRevert(Escrow.Deadline.selector);
        escrow.startMatch(ID, 1061, empty);
        escrow.timeout(ID);
        _claimAll(ID, [STAKE, STAKE, STAKE, STAKE]);
        bytes32 next = keccak256("active timeout");
        _create(escrow, next);
        _start(escrow, next);
        vm.warp(1480);
        escrow.timeout(next);
        for (uint256 i; i < 4; ++i) {
            vm.prank(seats[i]);
            assertEq(escrow.claimPayout(next), STAKE);
            assertEq(token.balanceOf(seats[i]), STAKE * 2);
        }
        assertEq(escrow.liability(), 0);
    }

    function testPendingTimeoutDoesNotRaceFinalizeAtDeadline() public {
        _start(escrow, ID);
        vm.warp(1419);
        Escrow.Result memory r = _result(escrow, ID, Escrow.Outcome.SABOTEUR);
        _submit(r);
        vm.warp(1539);
        r.merkleRoot = keccak256("late challenge");
        bytes[2] memory signatures = _signed(escrow.resultDigest(r), SIGNER_A, SIGNER_B);
        vm.expectRevert(Escrow.Deadline.selector);
        escrow.submitResult(r, signatures);
        vm.warp(1600);
        vm.expectRevert(Escrow.Deadline.selector);
        escrow.finalize(ID);
        escrow.timeout(ID);
        _claimAll(ID, [STAKE, STAKE, STAKE, STAKE]);
    }

    function testExactAllowanceSeatAndDuplicateDepositGuards() public {
        token.mint(seats[0], STAKE);
        vm.prank(seats[0]);
        token.approve(address(escrow), type(uint256).max);
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(seats[0]);
        escrow.joinAndDeposit(ID, STAKE);
        vm.expectRevert(Escrow.NotRecipient.selector);
        escrow.joinAndDeposit(ID, STAKE);
        _deposit(escrow, ID, seats[0]);
        vm.expectRevert(Escrow.InvalidAmount.selector);
        vm.prank(seats[0]);
        escrow.joinAndDeposit(ID, STAKE);
        assertEq(escrow.depositedFor(ID, seats[0]), STAKE);
        assertEq(escrow.liability(), STAKE);
    }
}
