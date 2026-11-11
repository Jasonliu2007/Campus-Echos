# v1.1 历史验收归档

归档时间：2026-11-11 10:07:19（Asia/Shanghai）。此目录保存上一批已产生的证据，**本次只复制和核对文件，没有重新执行这些业务**。当前状态与待办以 [项目交接](../../项目交接.md) 和 [开发日志](../../开发日志.md) 为准。

## 主要入口

- [历史交付与具体复测步骤](历史交付与复测.md)
- [最终模拟器总览](最终模拟器页面总览.jpg)
- [可点击原型与36张PNG](../../design-system/campus-echo/prototype-v1.1/index.html)
- [UI审计](audit/ui-audit.md) 与 [动效复核](audit/motion-review.md)

## 证据与实际边界

| 证据 | 历史结果 | 不能证明的范围 |
| --- | --- | --- |
| [本地回归](本地回归测试.tap) | 27客户端+19服务端，46通过 | 内存/模拟审核与隔离控制器不等于云端或真机 |
| [静态检查](最终静态检查.json) | 路由/语法/格式等静态结果 | 不等于模拟器交互 |
| [真实输入发布](final-native-published.json) | 模拟器真实cloud1返回pending及v1.1版本 | 不等于已公开或管理原生确认点通 |
| [真实云复核](final-real-approve.json) | 管理员云API复核公开 | 不等于真机人工操作全流程 |
| [刷新](final-approved-refresh.json)、[公开读取](final-public-read.json) | 云复核后列表/详情读到真实帖 | 不代表当前线上记录数 |
| [删除](final-test-cleanup.json)、[清理后空列表](final-public-empty.json) | 作者删除成功；当时公开0条 | 不代表云端断开；不要重复清库 |
| [真实分页](real-pagination.json)、[本人分页/清理](final-ui-pagination-cleanup.json) | 公开20+2、本人20→25，无重复 | 不代替真机长列表和新配置回归 |
| [三集合权限](real-client-permissions-final.json) | 客户端get/add均-502003拒绝 | 未另执行客户端破坏性update/delete测试 |
| [线上代码比对](线上v1.1代码比对.json) | index/service/repository/package与本地一致 | 这是当时结果，后续部署前需重新核 |
| [设置label点击](setting-label-after-tap.json)、[最终恢复](setting-final-restored.json) | 模拟器实点及保存核对 | 不等于真机读屏/键盘或低端性能 |
| [UI审计](audit/ui-audit.md)、[边界复核](audit/独立新增边界复测.json) | READY；12项独立边界通过 | 4项设备行为unknown；真机、第二账号待验 |

没有真机已通过证据。微信真实review/risky/异常、多账号审批/撤销/越权仍待复测。前期资料中的8项、16项等测试数是历史阶段，当前上一批汇总以46项为准。

原始材料来自聊天工作区 outputs/prototype-v1.1、outputs/ui-audit-v1.1、outputs/verification-v1与v1.1。仅复制了必要且已检查的历史证据；没有复制后台账号/密钥截图、私有bootstrap文件或线上函数私有配置。原聊天绝对路径保留在项目交接的追溯部分。

`文件来源与摘要.json` 给出复制来源、归档文件及SHA-256，便于排查复制损坏；摘要不能替代未来云端复测。`本批交接检查.json` 另记此次文档整理的验证，不混记业务通过。
