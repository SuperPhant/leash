// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";

/// @title UsdFaucet
/// @notice Hands out the testnet B20 USD token so anyone can try Leash. Needs MINT_ROLE on the token.
contract UsdFaucet {
    IB20 public immutable usd;
    uint256 public immutable amount;
    uint256 public immutable cooldown;

    mapping(address account => uint256) public lastClaim;

    event Claimed(address indexed account, uint256 amount);

    error TooSoon(uint256 nextClaimAt);

    constructor(IB20 usd_, uint256 amount_, uint256 cooldown_) {
        usd = usd_;
        amount = amount_;
        cooldown = cooldown_;
    }

    function claim() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + cooldown) revert TooSoon(last + cooldown);
        lastClaim[msg.sender] = block.timestamp;
        usd.mint(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
