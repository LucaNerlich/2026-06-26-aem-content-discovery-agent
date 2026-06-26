# Readme

Given Task / Content Brief PDF is in the [root of this project](AEM_Content_Discovery_Agent_Brief.pdf).

## Setup

### Prerequisites

- Java (JDK) 21
- Maven 3.9
- AEM Cloud SDK 2026.6

### Running the Agent / Project


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