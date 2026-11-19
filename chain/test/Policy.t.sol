// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RageFridge4337Policy as Policy} from "../src/RageFridge4337Policy.sol";
import {RageFridgeEscrow as Escrow} from "../src/RageFridgeEscrow.sol";
import {TestCredit} from "../src/TestCredit.sol";
import {OrderedEventLog} from "../src/OrderedEventLog.sol";

contract PolicyHarness {
    function envelope(Policy.Envelope calldata op, Policy.Deployment memory pin) external pure {
        Policy.validateEnvelope(op, pin);
    }

    function entry(
        Policy.Rules memory r,
        Policy.Execution mode,
        Policy.Call[] calldata calls,
        bytes calldata install,
        uint256 allowance,
        uint256 deposited
    ) external pure {
        Policy.validateOwnerEntry(r, mode, calls, install, allowance, deposited);
    }

    function session(
        Policy.Rules memory r,
        Policy.Session memory s,
        Policy.Context memory ctx,
        Policy.Execution mode,
        Policy.Call[] calldata calls
    ) external pure returns (uint256) {
        return Policy.validateSession(r, s, ctx, mode, calls);
    }

    function ownerClaim(Policy.Rules memory r, Policy.Call[] calldata calls) external pure {
        Policy.validateOwnerClaim(r, Policy.Execution.SINGLE_CALL, calls);
    }

    function sponsorship(
        Policy.PackedUserOperation calldata op,
        Policy.SponsorRules memory rules,
        Policy.Purpose purpose,
        bytes32 policyHash,
        uint256 nowSeconds
    ) external pure returns (bytes32) {
        return Policy.sponsorIntent(op, rules, purpose, policyHash, nowSeconds);
    }
}

contract PolicyTest is TestBase {
    PolicyHarness harness = new PolicyHarness();
    address constant ESCROW = address(20);
    address constant TOKEN = address(21);
    address constant ACCOUNT = address(22);
    address constant FACTORY = address(23);
    bytes32 constant ID = bytes32(uint256(1));
    bytes32 constant NONCE = bytes32(uint256(2));
    uint256 constant STAKE = 10;
    bytes constant INSTALL = hex"1122334455";

    function _rules() internal pure returns (Policy.Rules memory) {
        return Policy.Rules(ESCROW, TOKEN, ACCOUNT, ID, STAKE);
    }

    function _join() internal pure returns (Policy.Call memory) {
        return Policy.Call(ESCROW, 0, abi.encodeCall(Escrow.joinAndDeposit, (ID, STAKE)));
    }

    function _claim() internal pure returns (Policy.Call memory) {
        return Policy.Call(ESCROW, 0, abi.encodeCall(Escrow.claimPayout, (ID)));
    }

    function testOnlyPinnedPure4337Envelopes() public {
        bytes memory code = hex"aabbcc";
        bytes32 config = keccak256("factory plus module config");
        Policy.Deployment memory pin =
            Policy.Deployment(ACCOUNT, FACTORY, keccak256(hex"12345678"), keccak256(code), config);
        Policy.Envelope memory op = Policy.Envelope(
            43113,
            Policy.ENTRY_POINT_V07,
            ACCOUNT,
            false,
            false,
            false,
            abi.encodePacked(FACTORY, hex"12345678"),
            "",
            config
        );
        harness.envelope(op, pin);
        op.initCode = hex"7702000000000000000000000000000000000000";
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.initCode = "";
        op.senderCode = code;
        harness.envelope(op, pin);
        op.senderCode = abi.encodePacked(hex"ef0100", FACTORY);
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.senderCode = code;
        op.hasAuthorizationList = true;
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.hasAuthorizationList = false;
        op.hasEip7702Auth = true;
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.hasEip7702Auth = false;
        op.delegatedOrFallback = true;
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.delegatedOrFallback = false;
        op.chainId = 1;
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.chainId = 43113;
        op.entryPoint = FACTORY;
        vm.expectRevert(Policy.ForbiddenEnvelope.selector);
        harness.envelope(op, pin);
        op.entryPoint = Policy.ENTRY_POINT_V07;
        op.verifiedAccountConfigHash = 0;
        vm.expectRevert(Policy.DeploymentMismatch.selector);
        harness.envelope(op, pin);
    }

    function testOwnerEntryExactAtomicOrReject() public {
        Policy.Call[] memory calls = new Policy.Call[](4);
        calls[0] = Policy.Call(ACCOUNT, 0, INSTALL);
        calls[1] = Policy.Call(TOKEN, 0, abi.encodeCall(TestCredit.approve, (ESCROW, STAKE)));
        calls[2] = _join();
        calls[3] = Policy.Call(ESCROW, 0, abi.encodeCall(Escrow.setReady, (ID)));
        harness.entry(_rules(), Policy.Execution.ATOMIC_BATCH, calls, INSTALL, 0, 0);
        vm.expectRevert(Policy.ForbiddenExecution.selector);
        harness.entry(_rules(), Policy.Execution.UNKNOWN, calls, INSTALL, 0, 0);
        vm.expectRevert(Policy.ForbiddenExecution.selector);
        harness.entry(_rules(), Policy.Execution.ATOMIC_BATCH, calls, INSTALL, 1, 0);
        calls[1].data = abi.encodeCall(TestCredit.approve, (ESCROW, type(uint256).max));
        vm.expectRevert(Policy.ForbiddenCall.selector);
        harness.entry(_rules(), Policy.Execution.ATOMIC_BATCH, calls, INSTALL, 0, 0);
    }

    function testSessionExpiryRevocationNonceAndOwnerClaimRecovery() public {
        Policy.Session memory s = Policy.Session(NONCE, 100, 1900, false);
        Policy.Context memory ctx = Policy.Context(ACCOUNT, NONCE, 1899, STAKE);
        Policy.Call[] memory calls = new Policy.Call[](1);
        calls[0] = _claim();
        assertEq(harness.session(_rules(), s, ctx, Policy.Execution.SINGLE_CALL, calls), 0);
        ctx.nowSeconds = 1900;
        vm.expectRevert(Policy.SessionInactive.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.SINGLE_CALL, calls);
        harness.ownerClaim(_rules(), calls);
        ctx.nowSeconds = 99;
        vm.expectRevert(Policy.SessionInactive.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.SINGLE_CALL, calls);
        ctx.nowSeconds = 100;
        s.revoked = true;
        vm.expectRevert(Policy.SessionInactive.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.SINGLE_CALL, calls);
        s.revoked = false;
        ctx.activeSessionNonce = ID;
        vm.expectRevert(Policy.SessionInactive.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.SINGLE_CALL, calls);
    }

    function testSessionRejectsRepaymentBatchBypassesAndForbiddenCalls() public {
        Policy.Session memory s = Policy.Session(NONCE, 100, 1900, false);
        Policy.Context memory ctx = Policy.Context(ACCOUNT, NONCE, 100, STAKE);
        Policy.Call[] memory calls = new Policy.Call[](2);
        calls[0] = _join();
        calls[1] = _join();
        vm.expectRevert(Policy.SpendCapExceeded.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.ATOMIC_BATCH, calls);
        ctx.deposited = 0;
        vm.expectRevert(Policy.SpendCapExceeded.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.ATOMIC_BATCH, calls);
        calls[1] = _claim();
        assertEq(harness.session(_rules(), s, ctx, Policy.Execution.ATOMIC_BATCH, calls), STAKE);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodeCall(Escrow.joinAndDeposit, (ID, STAKE + 1)));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodeCall(Escrow.setReady, (NONCE)));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(TOKEN, 0, abi.encodeCall(TestCredit.approve, (ESCROW, STAKE)));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodeWithSignature("mintSouvenir(bytes32)", ID));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodeWithSignature("execute(bytes)", _claim().data));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodeWithSignature("claimPayout(bytes32,address)", ID, ACCOUNT));
        _rejectCall(s, ctx, calls);
        calls[0] = Policy.Call(ESCROW, 0, abi.encodePacked(_claim().data, hex"00"));
        _rejectCall(s, ctx, calls);
        calls[0] = _claim();
        calls[0].value = 1;
        _rejectCall(s, ctx, calls);
    }

    function _rejectCall(Policy.Session memory s, Policy.Context memory ctx, Policy.Call[] memory calls) private {
        vm.expectRevert(Policy.ForbiddenCall.selector);
        harness.session(_rules(), s, ctx, Policy.Execution.ATOMIC_BATCH, calls);
    }

    function testSponsorshipBindsOperationAndRejectsMissingOverBudgetAndExpired() public {
        Policy.SponsorRules memory rules =
            Policy.SponsorRules(address(24), 100, 120, 1000, 1000, 1000, 10, 10, 1000, 1000);
        Policy.PackedUserOperation memory op = Policy.PackedUserOperation(
            ACCOUNT,
            10,
            "",
            hex"12",
            Policy.pack(100, 200),
            100,
            Policy.pack(2, 4),
            abi.encodePacked(rules.paymaster, uint128(100), uint128(50)),
            ""
        );
        bytes32 intent = harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 100);
        ++op.nonce;
        assertTrue(intent != harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 100));
        --op.nonce;
        assertTrue(intent != harness.sponsorship(op, rules, Policy.Purpose.SESSION, ID, 100));
        assertTrue(intent != harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, NONCE, 100));
        op.callData = hex"13";
        assertTrue(intent != harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 100));
        op.gasFees = Policy.pack(1, 11);
        vm.expectRevert(Policy.SponsorshipDenied.selector);
        harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 100);
        op.gasFees = Policy.pack(1, 2);
        vm.expectRevert(Policy.SponsorshipDenied.selector);
        harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 120);
        op.paymasterAndData = "";
        vm.expectRevert(Policy.SponsorshipDenied.selector);
        harness.sponsorship(op, rules, Policy.Purpose.OWNER_CLAIM, ID, 100);
    }

    function testOrderedMerkleBindsMatchOrderIndexContentAndCount() public pure {
        bytes[] memory events = new bytes[](3);
        events[0] = hex"01";
        events[1] = hex"02";
        events[2] = hex"03";
        bytes32 original = OrderedEventLog.root(ID, events);
        assertTrue(original != OrderedEventLog.root(NONCE, events));
        assertTrue(OrderedEventLog.leaf(ID, 0, events[0]) != OrderedEventLog.leaf(ID, 1, events[0]));
        (events[0], events[1]) = (events[1], events[0]);
        assertTrue(original != OrderedEventLog.root(ID, events));
        (events[0], events[1]) = (events[1], events[0]);
        bytes[] memory padded = new bytes[](4);
        padded[0] = events[0];
        padded[1] = events[1];
        padded[2] = events[2];
        padded[3] = events[2];
        assertTrue(original != OrderedEventLog.root(ID, padded));
        events[2] = hex"04";
        assertTrue(original != OrderedEventLog.root(ID, events));
    }
}
