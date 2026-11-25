# 校园回声云接口 · v2.4（按证据区分验收）

本地论坛目标`wall-20261113-v1.4`，资料独立服务`trade-20261113-v1.1`（已部署并真实session核版本）、worker与举报清理见部署预检。当前Wall v1.4/Trade v1.1已部署；Worker v1.2/Cleanup v2.1修复并比对通过，25集合私有权限与41项索引已核。论坛单管理员与原创PDF试读已验；可信图片回调、每日物理清理、跨账号权益及手机待验。前端仅使用可信微信会话调用，不能自报操作者角色或身份。

当前新增契约：[论坛、搜索、图文、评论、治理与经验推荐](implementation-v2.4/论坛后端接口与清理.md)；[资料、订单、交付和售后](implementation-v2.4/trade-contract.md)。付费关闭。以下旧接口继续兼容；历史v2.3验证见verification-v2.3，不能作为本轮新接口通过证据。

所有结果平铺：成功 `{ok:true,version,traceId,...}`；失败 `{ok:false,version,traceId,code,message}`。`traceId` 是无身份的服务端诊断编号，微信调用自身另有 `requestID`。不要把错误当空列表，也不要在失败时清空输入。

## 会话与成员

| action | 参数 | 返回（除公共字段外） |
| --- | --- | --- |
| session | 无 | `{authenticated:true,canManageAdmins,member,access,categories}` |
| requestAccess | `nickname` 2–16 字，`reason` 2–200 字 | `{member,access}` |
| listMembers | 管理员；`status?`、`cursor?` | `{members,nextCursor,hasMore}` |
| reviewMember | 管理员；`memberId,revision,decision:'approve'/'reject'/'revoke',reason?` | `{member}` |
| setMemberRole | 仅初始管理员；`memberId,revision,role:'admin'/'member'` | `{member}` |

`member`：`{id,nickname,role,status,revision,createdAt,updatedAt,reviewReason?}`；管理界面另有申请说明 `reason`。`role` 为 `admin/member`，`status` 为 `pending/approved/rejected/revoked`；没有记录时 `member:null,access:'none'`。时间是服务端毫秒时间戳。成员 ID 是不透明散列，任何接口均不返回 OpenID。

登录页先执行真实 `wx.login` 并检查返回 code，再调用 session；微信云运行时提供当前小程序可信身份，不把客户端 code、缓存标记或前端角色当授权依据，也不向前端下发 AppSecret、OpenID 或虚构 token。登录和内测资格分开：`authenticated:true` 只说明请求来自有效微信上下文，不代表已获内测资格，更不代表学生实名认证。管理员使用同一微信账号登录即获得服务器确认的管理入口，无第二套管理员账号或登录。

未批准账号仅能调用 session/requestAccess。申请内容先执行微信安全审核，重复申请返回已有状态，不覆盖已审核材料。管理员审批通过时再次执行安全审核，仍为 review 的申请不会自动开放资格。审批、撤销和驳回使用 revision 防并发覆盖。

初始管理员仅由服务器变量 `BOOTSTRAP_ADMIN_OPENID`（优先）或隔离上传目录的私有 `deployment-config.json` 指定并在 session 首次命中时初始化，同时写入一次性锁。无变量不初始化；修改变量不能绕过已写入的一次性锁；管理页面不能撤销初始管理员。不要把后台账号 OpenID 与小程序用户 OpenID 混用。

`canManageAdmins` 只有在当前成员为 approved admin，且其成员 ID 匹配 `xiaopin_members/__bootstrap_admin_v1.memberId` 时为 true。该持久锁决定初始管理员的授权权威，修改环境变量不能转移它。仅初始管理员可向已批准成员授予或取消管理员权限；不能修改初始管理员自身，不能向待批准、驳回或撤销成员提权。setMemberRole 在事务内重读操作者、一次性锁、目标资格和 revision，更新角色与版本并写入 setMemberRole 审计；普通管理员即使伪造 role、canManageAdmins 或目标 ID 也无授权能力。

管理员身份与内测资格分别处理。要撤销被授权管理员的内测资格，须先由初始管理员取消其管理员权限；reviewMember 不能直接修改管理员。被授权者下次 session 即呈现管理入口；取消后所有管理请求重新校验服务器角色并被拒绝。角色变更和资格审批共享成员 revision，冲突返回 CONFLICT，前端须成功重新核对会话与成员列表后再次确认，超时不直接重放。

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

最终四分区：校园生活墙、表白墙、AI论坛墙、申研实习墙。旧记录读时映射到校园生活墙；原始举报快照不改写。经验采用独立community，不增加第五论坛分类。标题 1–60 字，正文 1–2000 字，按 Unicode 码点计数，首尾空格忽略；前端应按同一口径计数。`requestId` 满足 `/^[a-z0-9-]{10,64}$/`，失败重试必须复用同一内容的请求号；改内容须生成新请求号。相同请求号不新增重复帖子，不同内容复用请求号返回 REQUEST_CONFLICT。

历史v2.3发帖工具提交纯文字契约；v2.4新增community/isAnonymous/mediaIds及editPost，详扩展契约。预设符号、小标题、列表、分隔线和四分区模板只生成文本；客户端按行将 `【小标题】` 与分隔线呈现为阅读区块，不解析 HTML，不增加富文本、图片或附件字段。预览不替代服务器长度校验、微信审核和 requestId 去重。

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


## 举报与人工处理（v2.2）

以下接口仅获准内测成员可调用；管理操作另校验管理员。身份来自服务器上下文，传入role、OpenID或举报人编号不参与授权。

| action | 参数 | 返回 |
| --- | --- | --- |
| reportPost | `postId,reasonCode,detail?` | `{report,duplicate}` |
| listMyReports | `status?,cursor?` | `{reports,nextCursor,hasMore}` |
| reviewReports | 管理员；`status?,cursor?` | `{reports,nextCursor,hasMore}` |
| getReport | `reportId`，本人或管理员 | `{report}` |
| resolveReport | 管理员；`reportId,revision,postRevision,decision:'hide'/'dismiss',reason` | `{report}` |

原因固定为`illegal/scam/privacy/academic/abuse/other`（违法违规、诈骗广告、侵犯隐私、学术不端、人身攻击、其他）。补充说明按Unicode码点最多200字，其他2–200字；管理员处理说明2–200字。自由文本执行微信审核：risky拒绝，异常不成功，review只进入私有队列。帖子在事务提交时必须仍公开且非本人；同人同帖唯一记录，重复重试返回原记录，不覆盖说明。

report公开投影：`{_id,postId,reasonCode,status,resultLabel,revision,createdAt,updatedAt,resolvedAt,evidenceExpiresAt,evidenceExpired,overdue}`。四状态`pending/hidden/dismissed/unavailable`，固定结果“待处理／已下架／未认定违规／内容已不可见”。列表不复制帖子标题/正文或举报说明；每页20条，创建时间和ID倒序，游标绑定本人/管理员及筛选。管理列表pending超过24小时overdue=true。

getReport本人另见自己的detail（保留期内）；管理员另见snapshot、detail、resolveReason及currentPost。currentPost仅`{_id,status,revision}`，不绕过到期规则返回原文，不返回举报人OpenID/身份。snapshot只含举报当时标题、正文、分区、创建时间、版本。

resolveReport事务复查管理员资格、举报及帖子双版本；hide时原子下架、结案和审计，dismiss时保留公开。帖子已经不公开/删除/缺失时结果为unavailable，不恢复内容。作者仅见固定原因类别提示；举报者只见固定中性结果，不见管理员自由说明。冲突返回CONFLICT，必须刷新核对再确认，不自动重放。

新增`POST_UNAVAILABLE`表示提交时帖子已不可举报；`EVIDENCE_UNAVAILABLE`表示私有证据异常，保留输入并联系维护者。既有失败码兼容。

## 举报证据到期与服务器清理

私有集合`xiaopin_reports`保存必要记录；`xiaopin_report_evidence`保存快照、补充说明及管理员处理说明。举报审计只留必要编号、类别、结果、操作者和时间，不复制自由文本。客户端直接读写关闭。

结案时保存服务器`evidenceExpiresAt=resolvedAt+30天`。到期读取立即屏蔽快照和说明。独立`xiaopinReportCleanup`每日查询到期证据，事务重新核对结案和到期元数据，以最小记录替换证据全文。失败保留待重试并写无内容错误日志；Wall无清理action，不接受客户端时钟、批量清理或管理入口。实际部署与定时核对以verification-v2.2证据为准。


当前Trade v1.1补丁：getPrivatePdf/getPaymentProof/getPaymentQr在签发后事务重核实时成员/文件状态；订单双方existing权限保留。服务版本与年龄说明termsVersion分离，条款仍trade-20261113-v1。本地404/404；增量部署成功、线上6/6及真实session v1.1/terms v1/paid=false已证，见私有签发修复部署源码比对/真实会话。跨账号仍待验。

### 学校邮箱验证

- `session` 返回当前账号的 `campusEmailSupported`、`campusEmailRequired`、`campusEmailAvailable` 和 `campusEmailVerified`，成员及帖子公开字段不包含邮箱或绑定标识。
- `campusEmailSend({email})` 向合法学校邮箱发送 6 位验证码，通常返回 `resendAfter: 60`。发送配额按照微信账号和收件邮箱分别限制。 `campusEmailVerify({email,code})` 在同一微信账号核验验证码并绑定，成功返回 `campusEmailVerified: true`。
- 开启 `CAMPUS_EMAIL_GATE` 后，服务器拦截未验证账号的 `publish`，返回 `EMAIL_VERIFICATION_REQUIRED`。普通、匿名、引用、经验投稿由同一发布门禁覆盖。

### 私信图片

`directUpload` 接收原会话定位参数、`requestId` 和 Base64 图片。服务端按 500,000 字节校验，并复用微信图片审核。上传者通过 `getMedia` 查询审核状态。通过后可在 `directSend` 传入一个 `attachmentId`，文字可留空。服务端事务将图片绑定到一条消息。首次会话仍只允许一条消息，收件人接受后继续发送。

`directOpen` 的消息以 `hasAttachment` 标记有图片。`directAttachment({threadId,messageId})` 仅向有效会话的参与者提供 120 秒图片地址。论坛接口不出签私信图片。云部署需同时更新论坛函数与清理函数，以处理未发送的私信图片。

`directFindMember({nickname})` 按完整用户名查找（当前使用成员昵称），仅返回符合条件的内测成员对外 ID 和昵称。新会话可用 `peerId`、原帖 `postId`、已上架资料 `materialId` 或本人订单 `orderId` 发起。收件人第一条通过校验的回复与会话状态更新在同一事务中，发起方在收到回复前最多发送一条。旧有已接受的会话继续可用，旧按钮的单独接受操作不再开放。

`directSend` 可在资料或订单上下文附带整数分报价 `quoteCents`。资料标题和订单关联从服务端读取，报价只出现在私信，不改变订单价格、支付状态或购买权限。私信列表、论坛和订单履约接口保持独立。
