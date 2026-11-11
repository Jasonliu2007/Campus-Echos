# 校园回声云接口 v1

版本：`wall-20261111-v1.1`。前端通过 `wx.cloud.callFunction({name:'xiaopinWall', data:{action,...payload}})` 调用；禁止在前端提交身份或角色。AppID 与 OpenID 仅由云端 `getWXContext()` 取得。

所有结果平铺：成功 `{ok:true,version,traceId,...}`；失败 `{ok:false,version,traceId,code,message}`。`traceId` 是无身份的服务端诊断编号，微信调用自身另有 `requestID`。不要把错误当空列表，也不要在失败时清空输入。

## 会话与成员

| action | 参数 | 返回（除公共字段外） |
| --- | --- | --- |
| session | 无 | `{member,access,categories}` |
| requestAccess | `nickname` 2–16 字，`reason` 2–200 字 | `{member,access}` |
| listMembers | 管理员；`status?`、`cursor?` | `{members,nextCursor,hasMore}` |
| reviewMember | 管理员；`memberId,revision,decision:'approve'/'reject'/'revoke',reason?` | `{member}` |

`member`：`{id,nickname,role,status,revision,createdAt,updatedAt,reviewReason?}`；管理界面另有申请说明 `reason`。`role` 为 `admin/member`，`status` 为 `pending/approved/rejected/revoked`；没有记录时 `member:null,access:'none'`。时间是服务端毫秒时间戳。成员 ID 是不透明散列，任何接口均不返回 OpenID。

未批准账号仅能调用 session/requestAccess。申请内容先执行微信安全审核，重复申请返回已有状态，不覆盖已审核材料。管理员审批通过时再次执行安全审核，仍为 review 的申请不会自动开放资格。审批、撤销和驳回使用 revision 防并发覆盖。

初始管理员仅由服务器变量 `BOOTSTRAP_ADMIN_OPENID`（优先）或隔离上传目录的私有 `deployment-config.json` 指定并在 session 首次命中时初始化，同时写入一次性锁。无变量不初始化；修改变量不能绕过已写入的一次性锁；管理页面不能撤销初始管理员。不要把后台账号 OpenID 与小程序用户 OpenID 混用。

## 帖子

| action | 参数 | 返回 |
| --- | --- | --- |
| publish | `category,title,content,requestId` | `{postId,status,revision}` |
| list | `category?`、`cursor?` | `{posts,nextCursor,hasMore}` |
| listMine | `status?`、`cursor?` | `{posts,nextCursor,hasMore}` |
| getPost | `postId` | `{post}` |
| deletePost | `postId,revision`，仅作者 | `{postId,status,revision}` |
| reviewList | 管理员；`status?:'pending'/'published'`、`cursor?` | `{posts,nextCursor,hasMore}` |
| reviewPost | 管理员；`postId,revision,decision:'approve'/'reject',reason?` | `{postId,status,revision}` |
| hidePost | 管理员；`postId,revision,reason` | `{postId,status,revision}` |

`post`：`{_id,title,content,category,status,createdAt,updatedAt,authorName,isOwner,revision,reviewReason?}`。reason 仅作者及管理员可见。`status` 为 `published/pending/rejected/hidden/deleted`；删除后正文和标题清空，记录保留以保障请求去重和审计。列表默认只取已发布；本人可查本人全部状态；非公开详情只给作者和管理员。

每页 20 条，时间倒序、ID 倒序，`nextCursor` 是按筛选范围绑定的 opaque 字符串，最后一页为 null。切换分区/状态时清空旧游标并重新读取；异步请求乱序时只应用最新筛选结果。

四分区：失物招领、吐槽树洞、学习互助、闲置转让。标题 1–60 字，正文 1–2000 字，按 Unicode 码点计数，首尾空格忽略；前端应按同一口径计数。`requestId` 满足 `/^[a-z0-9-]{10,64}$/`，失败重试必须复用同一内容的请求号；改内容须生成新请求号。相同请求号不新增重复帖子，不同内容复用请求号返回 REQUEST_CONFLICT。

微信审核 pass 且不命中业务关键词时公开；review 或业务关键词命中时 pending；risky 拒绝；未知和异常失败关闭。管理员批准时重新执行微信审核，仅 pass 可以公开；仍为 review 返回 POST_REVIEW_REQUIRED 并保留 pending。复核返回 risky 时，事务写为 rejected、记录审核 trace 和 securityReject 审计，再返回 CONTENT_REJECTED；该帖子后续不能通过审核复活。未知/异常不得公开。驳回及下架须提供 2–200 字原因。

## 失败码

- `UNAUTHENTICATED`：必须从正确小程序进入。
- `ACCESS_DENIED`：无批准内测资格；重新取 session 并显示申请/等待/撤销状态。
- `FORBIDDEN`：无操作权限，不重复重试。
- `INVALID_INPUT/INVALID_ACTION/INVALID_CURSOR`：提示修改输入或刷新。
- `CONTENT_REJECTED/MODERATION_UNAVAILABLE/MEMBER_REVIEW_REQUIRED/POST_REVIEW_REQUIRED`：保留输入，不显示发布成功；管理端遇 CONTENT_REJECTED 应重新读取最新状态。
- `REQUEST_CONFLICT/CONFLICT`：重新读服务端状态；不得自动覆盖他人处置。
- `NOT_FOUND/AUTHOR_UNAVAILABLE/BOOTSTRAP_CONFLICT`：显示可恢复说明。
- `SERVICE_UNAVAILABLE`：保留已有数据和输入，显示重试入口。
