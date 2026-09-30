# COOS danmu runtime

直接跟随 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) 的完整弹幕组件发布仓库。
保留原管理 UI、来源及配置功能；仅适配 Node18/UZN 单文件打包、路径和托管 HTTP。
不包含 COOS 私有站点、网盘代码、Java 资产、用户配置或凭据。

Actions 每 6 小时检查原项目 main 的完整提交 SHA。打包配方或上游提交变化时，固定提交、生成依赖锁并构建 CJS，
在 Node 24 和精确 18.17.1 验证配置、管理页、上传、匹配、JSON/XML、持久化与独立启动。
构建失败不会更新发布通道。所有升级仍需通过宿主 COOS 的候选健康检查和快照回滚。

- 更新清单：`https://github.com/leotvgo/coos-danmu-runtime/releases/download/danmu-stable/manifest.json`
- 清单指向不可变 Release 的 CJS、MD5 和完整源码归档，记录上游及构建提交、依赖锁和文件哈希。
- COOS 管理页提供一键更新；服务器定时安装默认关闭，由管理员选择启用。
- UZN 独立脚本可使用不可变 Release 中的 `.cjs.md5` 地址，或 COOS 提供的动态订阅地址。
- 这些自动验证不代表所有外部平台或真实 UZN 播放都已验收。

## 本地构建

安装本仓库依赖后，指定仓库外的空临时目录：

```sh
npm ci
node scripts/prepare.mjs /tmp/coos-danmu-work
# 从 plan.json 读取 recipe；builder-commit 为本仓库当前完整提交。
node scripts/build.mjs /tmp/coos-danmu-work/upstream /tmp/coos-danmu-work/artifact <recipe> <builder-commit>
DANMU_ARTIFACT_DIR=/tmp/coos-danmu-work/artifact npm test
```

原项目 AGPL-3.0 许可保留。CJS 打包策略参考 YYDS678/danmu_api 的 build-for-uzn.mjs，
COOS 的打包与运行适配以相同许可提供。每个 Release 的 source.tar.gz 包含固定上游源码、依赖锁和此仓库的对应源码。
