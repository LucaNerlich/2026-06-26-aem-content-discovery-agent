# Readme

Given Task / Content Brief PDF is in the [root of this project](AEM_Content_Discovery_Agent_Brief.pdf).

Read [why.md](./why.md) for the reasoning behind decisions made in this project.

## Setup

### Prerequisites

- NodeJS 22
- sqlite3
- Ollama
- 32+gb (V)RAM

Optional Requirements, when running against a live AEM as a data-source:

- Java (JDK) 21
- Maven 3.9
- AEM Cloud SDK 2026.6 running at http://localhost:4502

### Running the Agent / Project

#### Prepare AEM

1. `git clone git@github.com:LucaNerlich/2026-06-26-aem-content-discovery-agent.git`
2. `cd 2026-06-26-aem-content-discovery-agent/aemcontentdisc`
3. `mvn clean install -PautoInstallSinglePackage`
4. Install the AEM MCP Content Package
   from https://experience.adobe.com/#/downloads/content/software-distribution/en/aemcloud.html?fulltext=mcp*&orderby=%40jcr%3Acontent%2Fjcr%3AlastModified&orderby.sort=desc&layout=list&p.offset=0&p.limit=3
    - `com.adobe.aem.mcp-server-contribs-content-0.1.6.zip`

AEM MCP

```json
{
  "url": "http://localhost:4502/bin/mcp",
  "requestInit": {
    "headers": {
      "Authorization": "Basic YWRtaW46YWRtaW4="
    }
  }
}
```

#### Prepare local AI

1. `ollama pull gemma4:26b` (https://ollama.com/library/gemma4)
    - All-round frontier model
2. `ollama pull embeddinggemma` (https://ollama.com/library/embeddinggemma)
    - Multilingual embedding model

## Technical Setup / History

> Steps I took to setup the initial project

Setup an AEM project using the AEM Project Archetype

```bash
mvn -B org.apache.maven.plugins:maven-archetype-plugin:3.3.1:generate \
 -D archetypeGroupId=com.adobe.aem \
 -D archetypeArtifactId=aem-project-archetype \
 -D archetypeVersion=56 \
 -D appTitle="aem-content-discovery" \
 -D appId="aemcontentdisc" \
 -D groupId="com.acs" \
 -D includeExamples="y" \
 -D datalayer="n"
```

## External Documentation

- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools
- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/mcp-support/using-mcp-with-aem-as-a-cloud-service