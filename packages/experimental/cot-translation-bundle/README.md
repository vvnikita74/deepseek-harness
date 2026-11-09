---
description: "Machine translation service for displayed reasoning; this fork ships no browser surface for it."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cot-translation-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle mounts the translator service, which translates expanded reasoning through Bing or Google. This fork has no browser surface for translation, so enabling the bundle adds no visible control. Shipped profiles leave it disabled. Original reasoning stays unchanged in the Session and model input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This fork ships no Plugins-page switch, translation toolbar, or Think-row control for this bundle, so no surface starts a translation. The `translator` service it mounts is available to code that calls it.

The selected service receives the expanded reasoning, which can contain private code and conversation details. Google and Bing send source text in POST request bodies. Bing and Google require no additional login or API key, but neither anonymous endpoint guarantees availability or free quotas. Eligible native `deepseek-flash` routes appear as explicit paid choices using the configured DeepSeek Account or Official API credentials. Each uncached fragment issues one independent query with thinking disabled. Reopening reuses saved results; changing provider, language, source or recipe may require another billed query. The model ID is matched without a version number, and pi-ai routes are excluded. Provider failure never sends the text to another service automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle patch inserts the `translator` row. The translator owns provider protocols, network limits, and shared persisted requests and results. The browser consumer that scheduled paragraphs and kept a local display cache was removed with the frontend. The translation wrapper and Chat's default Body entry both call the official reasoning Content Factory.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Text translation subsystem](../../../docs/subsystems/translation.md) · [Translator service](../translator/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through optional independent paid Flash requests and normal Session activation on cache misses; the translator owns translation prompts, and the Session's preset owns startup context.

#### KV Cache effect

Translation records leave original reasoning intact; with no consumer in this fork, the bundle adds no request cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Nothing in this fork starts translation, so the bundle has no visible effect until a consumer calls the translator service.
- Anonymous Google and Bing browser endpoints may fail, rate-limit requests, or change their response formats. Mainland China connectivity depends on the deployment's network and proxy configuration. Successful translations remain in the Session after bundle removal or restart. Experimental records have best-effort retention across future Session-format migrations.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
