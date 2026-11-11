# v1.1 动效独立复核

| Before | After | Why |
| --- | --- | --- |
| role是网页属性，辅助设置只命中switch | 原生aria-role与整行label | 减少触控和辅助操作摩擦，不通过动画弥补。 |
| 按压/松手对称且chip transform无显式缓动 | 下压60ms，恢复120ms，显式强缓出；级联已独立复核 | 反馈即时且松手平稳，CSS可中断。 |

代码结论：**Approve**。共享样式和Tab使用显式属性过渡、短时反馈及减弱动态路径；无需要删除的装饰循环。本批已知按压时序与管理输入问题已修并复跑。玻璃为静态材质，不动画blur。页面/确认由微信原生处理，不声称控制其时长。

位置：components/campus-ui/page.wxss:273（chip缓动）、components/campus-ui/page.wxss:693（最终press级联）、custom-tab-bar/index.wxss:61（Tab press）、pages/notes-ai/index.js:36（减弱动态）。实际设备快速重复操作、中断、0.1倍速录屏、低端滚动、触控和次日复看尚待执行；此结论不是设备性能通过。
