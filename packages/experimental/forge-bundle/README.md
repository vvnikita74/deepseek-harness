---
description: "Change request services and worktree Sessions; this fork ships no panel."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle mounts the change request services, the GitHub provider, and the model's worktree tool, so the model can create a Git worktree during a conversation. This fork ships no change request panel or composer control, and shipped profiles leave the bundle disabled. GitHub status comes from the Host's signed-in `gh` CLI; local worktree creation does not require GitHub authentication.

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

This fork ships no panel, composer control, or Plugins-page switch for this bundle, so no surface shows change requests or worktree choices. Run `gh auth login --hostname <host>` in a terminal to sign in; the GitHub provider uses the signed-in `gh` CLI.

The bundle mounts the model's [`create_worktree`](../tool-worktree/README.md) tool. Disabling the bundle removes the tool while retaining existing checkouts and branches. For profiles that already selected the standalone worktree bundle, follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.md) before enabling this bundle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle mounts the forge registry, GitHub provider, Session bindings, and the worktree model tool. The tool uses the top-level `worktree` service. The rows use the Session projection, working-directory, filesystem, subprocess, and sandbox services from base-backed profiles.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Forge subsystem](../../../docs/subsystems/forge.md) · [Session bindings](../forge-session/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [`create_worktree`](../tool-worktree/README.md#model-experience) tool.

#### KV Cache effect

Enabling or disabling the bundle changes the model's tool schema list. Calls append tool results and directory context; see the [tool's cache behavior](../tool-worktree/README.md#model-experience).

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- GitHub is the only code host provider, and the bundle serves github.com only; a GitHub Enterprise host needs a profile patch that lists it in the `forge-github` row's [`hosts`](../forge-github/README.md#use-this-package). No provider recognizes GitLab or other hosts.
- The model has no tool for bound change requests yet.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
