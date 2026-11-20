// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {LeashDesk} from "./LeashDesk.sol";
import {LeashVault} from "./LeashVault.sol";

/// @title LeashFactory
/// @notice Creates {LeashVault}s and indexes them by owner and by the agent they were created for.
contract LeashFactory {
    LeashDesk public immutable desk;
    IB20 public immutable usd;

    address[] internal _vaults;
    mapping(address owner => address[]) internal _byOwner;
    mapping(address agent => address[]) internal _byAgent;
    mapping(address vault => bool) public isVault;

    event VaultCreated(address indexed vault, address indexed owner, address indexed agent, uint256 initialDeposit);

    constructor(LeashDesk desk_) {
        desk = desk_;
        usd = desk_.usd();
    }

    function createVault(
        address agent,
        address[] calldata assets,
        uint16[] calldata caps,
        LeashVault.Mandate calldata mandate,
        uint256 initialDeposit
    ) external returns (address vault) {
        vault = _create(agent, assets, caps, mandate, initialDeposit);
        if (initialDeposit != 0) usd.transferFrom(msg.sender, vault, initialDeposit);
    }

    /// @notice One-transaction onboarding: EIP-2612 permit on the B20 USD token, create, fund.
    function createVaultWithPermit(
        address agent,
        address[] calldata assets,
        uint16[] calldata caps,
        LeashVault.Mandate calldata mandate,
        uint256 initialDeposit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (address vault) {
        // A front-run permit only consumes the signature; the allowance it set is still usable.
        try usd.permit(msg.sender, address(this), initialDeposit, deadline, v, r, s) {} catch {}
        vault = _create(agent, assets, caps, mandate, initialDeposit);
        usd.transferFrom(msg.sender, vault, initialDeposit);
    }

    function _create(
        address agent,
        address[] calldata assets,
        uint16[] calldata caps,
        LeashVault.Mandate calldata mandate,
        uint256 initialDeposit
    ) internal returns (address vault) {
        vault = address(new LeashVault(msg.sender, agent, desk, assets, caps, mandate));
        _vaults.push(vault);
        _byOwner[msg.sender].push(vault);
        _byAgent[agent].push(vault);
        isVault[vault] = true;
        emit VaultCreated(vault, msg.sender, agent, initialDeposit);
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaults() external view returns (address[] memory) {
        return _vaults;
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _byOwner[owner];
    }

    /// @notice Vaults created for `agent`. Owners can change agents later, so check `vault.agent()` before acting.
    function vaultsByAgent(address agent) external view returns (address[] memory) {
        return _byAgent[agent];
    }
}
