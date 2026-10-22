// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestToken {
    string public symbol = "TEST";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    bool public transfersBlocked;
    function setTransfersBlocked(bool blocked) external { transfersBlocked = blocked; }
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(!transfersBlocked, "transfers blocked");
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
