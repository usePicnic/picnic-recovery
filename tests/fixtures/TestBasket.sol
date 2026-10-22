// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface BasketToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
}
interface NftReceiver { function onERC721Received(address,address,uint256,bytes calldata) external returns (bytes4); }
contract TestBasketWallet {
    address public controller;
    constructor() { controller = msg.sender; }
    function send(address token, address to, uint256 amount) external {
        require(msg.sender == controller);
        require(BasketToken(token).transfer(to, amount));
    }
}
contract TestBasket {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public walletOf;
    event Transfer(address indexed from,address indexed to,uint256 indexed tokenId);
    struct Outputs { address[] tokens; uint256[] amounts; }
    function mint(uint256 id, address owner) external {
        require(ownerOf[id] == address(0));
        ownerOf[id] = owner;
        walletOf[id] = address(new TestBasketWallet());
        emit Transfer(address(0), owner, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) external {
        require(msg.sender == from && ownerOf[id] == from && to != address(0));
        ownerOf[id] = to;
        emit Transfer(from, to, id);
        if (to.code.length > 0) require(NftReceiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02);
    }
    function withdrawPortfolio(uint256 id, Outputs calldata outputs, uint256 ethPct, address[] calldata bridges, bytes[] calldata calls) external {
        require(ownerOf[id] == msg.sender && ethPct == 0 && bridges.length == 0 && calls.length == 0);
        for (uint256 i; i < outputs.tokens.length; i++) {
            uint256 amount = BasketToken(outputs.tokens[i]).balanceOf(walletOf[id]) * outputs.amounts[i] / 100000;
            TestBasketWallet(walletOf[id]).send(outputs.tokens[i], msg.sender, amount);
        }
    }
}
