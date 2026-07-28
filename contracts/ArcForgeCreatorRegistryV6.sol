// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Bounded creator metadata and launch records for the active V6 Factory.
contract ArcForgeCreatorRegistryV6 is Ownable2Step {
    uint256 public constant MAX_METADATA_URI_BYTES = 512;

    struct CreatorProfile {
        string metadataURI;
        uint64 launchCount;
        uint64 graduatedCount;
        uint64 flaggedCount;
        bool registered;
    }

    address public factory;
    mapping(address creator => CreatorProfile profile) private profiles;

    event CreatorRegistered(address indexed creator, string metadataURI);
    event CreatorUpdated(address indexed creator, string metadataURI);
    event CreatorLaunchRecorded(address indexed creator, address indexed token, uint256 launchCount);
    event FactoryUpdated(address indexed previousFactory, address indexed newFactory);

    error ZeroAddress();
    error Unauthorized();
    error AlreadyRegistered();
    error NotRegistered();
    error MetadataURITooLong();
    error RenounceDisabled();

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0) || newFactory.code.length == 0) revert ZeroAddress();
        address previous = factory;
        factory = newFactory;
        emit FactoryUpdated(previous, newFactory);
    }

    function registerCreator(string calldata metadataURI) external {
        _register(msg.sender, metadataURI);
    }

    function registerCreatorFor(address creator, string calldata metadataURI) external {
        if (msg.sender != factory) revert Unauthorized();
        _register(creator, metadataURI);
    }

    function updateCreatorMetadata(string calldata metadataURI) external {
        _validateMetadata(metadataURI);
        CreatorProfile storage profile = profiles[msg.sender];
        if (!profile.registered) revert NotRegistered();
        profile.metadataURI = metadataURI;
        emit CreatorUpdated(msg.sender, metadataURI);
    }

    function recordLaunch(address creator, address token) external {
        if (msg.sender != factory) revert Unauthorized();
        if (creator == address(0) || token == address(0)) revert ZeroAddress();
        CreatorProfile storage profile = profiles[creator];
        if (!profile.registered) {
            profile.registered = true;
            emit CreatorRegistered(creator, "");
        }
        unchecked {
            profile.launchCount += 1;
        }
        emit CreatorLaunchRecorded(creator, token, profile.launchCount);
    }

    function getCreatorProfile(address creator) external view returns (CreatorProfile memory) {
        return profiles[creator];
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _register(address creator, string calldata metadataURI) private {
        if (creator == address(0)) revert ZeroAddress();
        _validateMetadata(metadataURI);
        if (profiles[creator].registered) revert AlreadyRegistered();
        profiles[creator] = CreatorProfile(metadataURI, 0, 0, 0, true);
        emit CreatorRegistered(creator, metadataURI);
    }

    function _validateMetadata(string calldata metadataURI) private pure {
        if (bytes(metadataURI).length > MAX_METADATA_URI_BYTES) revert MetadataURITooLong();
    }
}
