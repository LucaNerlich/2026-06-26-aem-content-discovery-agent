# aemcontentdisc — AEM project module

This Maven project defines the AEM-side artifacts used by the AEM Content Discovery
Agent: the **`discovery-fragment` Content Fragment Model** that backs the corpus, the
DAM paths under `/content/dam/aemcontentdisc/{locale}/` that the seeder writes to, and
the OSGi config / dispatcher scaffolding needed to install the package on a local AEM
SDK. It is **not** a generic AEM starter — the agent itself lives in the root Node
workspaces (`shared/`, `content-seeder/`, `discovery-agent/`).

The AEM round-trip is **optional**. The default JSON-primary path uses `data/corpus.json`
and needs no AEM at all. See the root [`README.md`](../README.md) for build, seed, and
run instructions for the agent.

## Modules in use

| Module          | Purpose for this project                                                       |
|-----------------|--------------------------------------------------------------------------------|
| `core`          | Java bundle (kept minimal — required by `all`)                                 |
| `ui.apps`       | Apps tree (Core Components proxy + minimal scaffolding)                        |
| `ui.apps.structure` | Repository structure package required by ui.apps                          |
| `ui.content`    | **CF Model definition** (`/conf/aemcontentdisc/.../discovery-fragment`) and DAM tree roots per locale |
| `ui.config`     | OSGi runmode configs (logging, repoinit for the DAM tree, CORS)                |
| `dispatcher`    | Local dispatcher config (only needed for the AEM round-trip)                   |
| `all`           | Aggregator content package that bundles everything for `autoInstallPackage`    |
| `analyse`       | `aemanalyser-maven-plugin` static analysis for AEMaaCS compatibility           |

## When you need it

Only install this package if you want to exercise `--source=aem` end-to-end:

```bash
# 1. Start the AEM Cloud SDK at http://localhost:4502 (admin:admin)
# 2. Install the package
cd aemcontentdisc
mvn clean install -PautoInstallSinglePackage
# 3. Seed the corpus into AEM
cd ..
npm run seed -- --aem-push --reset --seed=20260626
# 4. Run the agent against live AEM
npm run agent -- eval/briefs/winter-sustainable.txt --source=aem
```

The seeder POSTs one Content Fragment per corpus row against the `discovery-fragment`
CF Model defined in `ui.content`. The agent reads them back via the Assets HTTP API.
