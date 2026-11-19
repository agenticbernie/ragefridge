// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Vm {
    function chainId(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue");
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq uint");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq address");
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "assertEq bytes32");
    }
}
