// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {TestCredit} from "../src/TestCredit.sol";
import {RageFridgeEscrow as Escrow} from "../src/RageFridgeEscrow.sol";
import {RageFridge4337Policy as Policy} from "../src/RageFridge4337Policy.sol";

/// @dev Only models an executor that reverts the entire batch. No ERC-4337 authentication or deployment.
contract AtomicCallFixture {
    bytes32 public installedPolicy;

    error BadFixtureCall();
    error BatchReverted();

    function install(bytes32 digest) external {
        if (msg.sender != address(this) || digest == 0) revert BadFixtureCall();
        installedPolicy = digest;
    }

    function execute(Policy.Call[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = calls[i].target.call(calls[i].data);
            if (!ok) revert BatchReverted();
        }
    }
}

contract AtomicEntryTest is TestBase {
    bytes32 constant ID = bytes32(uint256(1));
    bytes32 constant POLICY = bytes32(uint256(2));
    uint256 constant STAKE = 100;
    TestCredit token;
    Escrow escrow;
    AtomicCallFixture account;

    function setUp() public {
        vm.chainId(43113);
        account = new AtomicCallFixture();
        token = new TestCredit();
        escrow = new Escrow(token, [address(11), address(12), address(13)]);
        escrow.createMatch(ID, [address(account), address(1), address(2), address(3)], STAKE, POLICY, POLICY);
        token.mint(address(account), STAKE);
    }

    function _batch() private view returns (Policy.Call[] memory calls) {
        calls = new Policy.Call[](4);
        calls[0] = Policy.Call(address(account), 0, abi.encodeCall(AtomicCallFixture.install, (POLICY)));
        calls[1] = Policy.Call(address(token), 0, abi.encodeCall(TestCredit.approve, (address(escrow), STAKE)));
        calls[2] = Policy.Call(address(escrow), 0, abi.encodeCall(Escrow.joinAndDeposit, (ID, STAKE)));
        calls[3] = Policy.Call(address(escrow), 0, abi.encodeCall(Escrow.setReady, (ID)));
    }

    function testRollbackAtEveryCallInAtomicFixture() public {
        for (uint256 i; i < 4; ++i) {
            Policy.Call[] memory calls = _batch();
            if (i == 0) calls[0].data = abi.encodeCall(AtomicCallFixture.install, (bytes32(0)));
            if (i == 1) calls[1].data = abi.encodeCall(TestCredit.approve, (address(0), STAKE));
            if (i == 2) calls[2].data = abi.encodeCall(Escrow.joinAndDeposit, (ID, STAKE + 1));
            if (i == 3) calls[3].data = abi.encodeCall(Escrow.setReady, (bytes32(0)));
            vm.expectRevert(AtomicCallFixture.BatchReverted.selector);
            account.execute(calls);
            assertEq(account.installedPolicy(), bytes32(0));
            assertEq(token.allowance(address(account), address(escrow)), 0);
            assertEq(token.balanceOf(address(account)), STAKE);
            assertEq(token.balanceOf(address(escrow)), 0);
            assertEq(escrow.liability(), 0);
            assertEq(escrow.getMatch(ID).ready, 0);
        }
    }

    function testZeroNativeBalanceEntryAndRetryWithoutRedepositInFixture() public {
        assertEq(address(account).balance, 0);
        account.execute(_batch());
        assertEq(address(account).balance, 0);
        assertEq(account.installedPolicy(), POLICY);
        assertEq(token.allowance(address(account), address(escrow)), 0);
        assertEq(escrow.depositedFor(ID, address(account)), STAKE);
        assertEq(escrow.getMatch(ID).ready, 1);
        Policy.Call[] memory retry = _batch();
        vm.expectRevert(AtomicCallFixture.BatchReverted.selector);
        account.execute(retry);
        assertEq(token.allowance(address(account), address(escrow)), 0);
        assertEq(escrow.liability(), STAKE);
        assertEq(token.balanceOf(address(escrow)), STAKE);
    }
}
