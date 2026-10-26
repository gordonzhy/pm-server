# 自动发布到 npm

`check.yml` 对 push 和 pull request 运行 macOS Node 22、24 测试矩阵。只有本仓库 `main` 分支的 push 且两项测试全部成功，才运行下游 Ubuntu 发布 job。npm 还必须配置匹配的可信发布关系；仅提交 workflow 不代表已接通认证。

发布使用 GitHub Actions OIDC，仅发布 job 有 `contents: read` 和 `id-token: write`，无需 npm token secret。npm 包 `pm-server` 的可信来源应为 GitHub owner `gordonzhy`、仓库 `pm-server`、workflow 文件 `check.yml`、environment `npm-next`，开启直接发布能力，并保留下文所述的平台固定暂存权限。GitHub 的该 environment 必须使用自定义分支策略，仅允许 `main` 分支部署，不配置 tag 规则；分支限制属于安全边界，只有 workflow 条件不足以替代。不要增加无关操作或修改账号整体认证设置。使用 GitHub-hosted runner、Node 24 和 npm 11.16.0。参阅 [npm 官方可信发布说明](https://docs.npmjs.com/trusted-publishers/)。

npm 新建可信关系固定包含暂存发布权限，开启直接发布后的有效组合为 `createPackage` 与 `createStagedPackage`，仍只限上述包及 workflow 范围；不要授予 `manageDistTags`。本 workflow 只直接发布到 `next`，不提交或批准暂存包。暂存包转为公开版本仍需维护者审核及 2FA 批准。平台固定的暂存权限无法从新建直接发布关系中移除。

版本规则为 `<基础版本>-ci.<workflow运行编号>.<源SHA前12位>`，如 `0.1.0-ci.123.aaaaaaaaaaaa`。基础版本取 `package.json` 数字部分；包内 `releaseSource` 记录完整公开源 SHA 和运行编号。只在 runner 内更新版本，不向仓库回写版本提交或标签。npm provenance 记录公开仓库与构建身份。

发布始终使用 `next`，不提升 `latest`。同包发布 job 串行；发布前核对当前 main 和 next，过时运行跳过，GitHub 可能替换排队中的运行。最终 main 核对后若又有新 push，next 可能短暂保留前一版本，直到后续运行成功。失败或被取代的 push 不保证发布。

发布脚本检查明确的归档文件清单、必要许可、源码与归档字节、包元数据及通用隐私特征。这些检查需要配合源码、图片及动态输出的人工作品审阅，不能证明任意实例数据可公开。修改归档清单须单独审阅。发布前再次打包核对候选 SRI，使用目录发布避免 tarball 来源的绝对路径元数据，npm 上传归档必须与准确受测候选同字节。发布后匿名下载准确注册表归档，核 SRI，临时目录正常安装，比对完整安装文件并运行 CLI help，不安装全局或修改服务。

重跑同一 workflow 运行复用版本；已存在版本必须具有相同 SRI 和来源，不重复发布或移动 next。发布结果不明确时先查准确注册表版本。匹配的已发布版本在重跑时仍执行匿名下载与安装检查。成功 job 的 summary 提供候选与结果收据，失败日志留在 Actions。

暂停自动发布可在 GitHub Actions 禁用 workflow，或在 npm 设置中移除本包的特定可信关系。禁用整个 workflow 同时暂停测试；仅停发布而保留 CI 时，通过审阅变更停用或移除 `publish-next` job。已发布版本不可覆盖，缺陷通过新的审阅 push 修复。将 next 回退到旧受测版本属于维护者显式操作，须与运行中发布协调，不改变 latest 或删除版本。
