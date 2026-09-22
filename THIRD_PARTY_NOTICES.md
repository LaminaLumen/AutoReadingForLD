# 第三方来源说明

澜阅基于以下项目的思路与早期实现进行重构：

- 项目：`Antman2023/linux.do-autoscroll`
- 原脚本：`linux-do-autoscroll.user.js`
- 原作者标识：`pboy`
- 原项目地址：<https://github.com/Antman2023/linux.do-autoscroll>
- 原许可声明：MIT License

本项目保留原作者署名，并继续使用 MIT License。

2.0.0 对脚本进行了大范围重写，包括但不限于：项目命名、元数据、基于时间的滚动内核、底部等待策略、状态管理、Pointer Events 拖拽、Shadow DOM 样式隔离、控制台界面、可访问性、配置迁移、文档和验证流程。

## 图标

控制台内嵌了 Phosphor Icons 2.1.1 Regular 的部分 SVG 路径：

- 项目：Phosphor Icons
- 项目地址：<https://github.com/phosphor-icons/core>
- 使用范围：阅读模式、播放/暂停/停止、速度、参数、统计、阅读保护、复位与收起入口图标
- 许可：MIT License

图标路径随脚本一同分发，不会在运行时请求远程字体、图标库或第三方服务器。
