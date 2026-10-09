# 待办

## 待实现（发布前）

相关的决定见 ADR 0014、ADR 0015、ADR 0016、ADR 0017。

1. **测试网实测**。这一条要人来做，需要测试地址的私钥和测试网 MON：
   1. 用专门的测试地址在 Monad 测试网（10143）部署官方合约。这个地址先拿到 ADMIN 和 UPGRADER。
   2. 把测试网的 Factory 地址填进 `frontend/chain.js`。
   3. 把测试网地址（Roles、两个引擎版本、Factory 代理和实现）写进 `contracts/README.md` 和 `contracts/README.en.md`。
   4. 在测试网区块浏览器上核对合约源码。
   5. 在 Monad 测试网上用真钱包走一遍：部署 → step → reset → 核对（包括带工具层的组合器）。
   6. 记下每笔交易的 gas。

   目前只在本地 Anvil 上验证过。
