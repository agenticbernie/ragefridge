// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Ordered RageFridge event commitment, v1. Does not prove the event claims or availability.
/// @dev Inputs are canonical, versioned and privacy-safe event bytes from the replay layer. A verifier
/// must independently reproduce those bytes and compare the final root, not trust asserted leaf hashes.
library OrderedEventLog {
    bytes32 internal constant DOMAIN = keccak256("RageFridge.EventLog.v1");

    function leaf(bytes32 matchId, uint256 index, bytes memory encodedEvent) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, uint8(0), matchId, index, keccak256(encodedEvent)));
    }

    function node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, uint8(1), left, right));
    }

    function root(bytes32 matchId, bytes[] memory canonicalEvents) internal pure returns (bytes32) {
        uint256 count = canonicalEvents.length;
        bytes32 top;
        if (count != 0) {
            bytes32[] memory level = new bytes32[](count);
            for (uint256 i; i < count; ++i) {
                level[i] = leaf(matchId, i, canonicalEvents[i]);
            }
            for (uint256 width = count; width > 1;) {
                uint256 nextWidth = width / 2 + width % 2;
                for (uint256 i; i < nextWidth; ++i) {
                    uint256 leftIndex = i * 2;
                    uint256 rightIndex = leftIndex + 1;
                    level[i] = node(level[leftIndex], level[rightIndex < width ? rightIndex : leftIndex]);
                }
                width = nextWidth;
            }
            top = level[0];
        }
        return keccak256(abi.encode(DOMAIN, uint8(2), matchId, count, top));
    }
}
