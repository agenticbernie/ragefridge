// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestCredit} from "../src/TestCredit.sol";
import {RageFridgeEscrow} from "../src/RageFridgeEscrow.sol";

interface BroadcastVm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Simulation by default. Broadcasting requires an explicit forge CLI flag and signer.
contract DeployFuji {
    BroadcastVm private constant vm = BroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run(address[3] calldata signers) external returns (TestCredit token, RageFridgeEscrow escrow) {
        require(block.chainid == 43113, "Fuji only");
        for (uint256 i; i < 3; ++i) {
            require(signers[i] != address(0), "Zero signer");
            for (uint256 j; j < i; ++j) require(signers[i] != signers[j], "Duplicate signer");
        }
        vm.startBroadcast();
        token = new TestCredit();
        escrow = new RageFridgeEscrow(token, signers);
        vm.stopBroadcast();
    }
}
