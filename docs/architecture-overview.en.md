# Architecture Overview

[Back to Home](../README.en.md) · [简体中文](architecture-overview.md) · [Full Technical Architecture](ARCHITECTURE.en.md) · [Patching Workflow](PATCHING_WORKFLOW.en.md)

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    Desktop["macOS / Windows / Linux clients"]
    Mobile["iOS / Android clients"]
    Web["Web client (:18081)"]
  end

  subgraph HostC["host container"]
    Admin["Admin service (:18080)<br/>sign-in / pairing / settings / push / updates"]
    Core["Original Host<br/>agents / tools / context / schedules"]
    Adapter["Model adapter<br/>routing / fallbacks / auto-review"]
    Admin --> Core --> Adapter
  end

  Desktop --> Admin
  Mobile --> Admin
  Web --> Admin
  Adapter --> Models["Your model endpoints<br/>Chat / Responses / Anthropic"]
  Core --> Box["box container<br/>Linux desktop + VNC"]
  Core -.reverse connection via client.-> PC["Your Mac / Windows computer"]
  Admin --> Push["APNs / Bark / ntfy and other push"]
  Admin <--> Tailcat["Tailcat encrypted network"]
```

- **Host:** the original Node.js program. Only the parts tied to official services are replaced (authentication, agent identity, model calls and MCP configuration), and an admin service sits in front of it.
- **Execution computer:** the official Linux desktop image, running unchanged in Docker. Agents can also work on your own computer.
- **Clients:** the original interface is kept, and the patches make it connect only to your Host. Patches only copy and add bytes, and every segment checks the original file's hash first. Nothing is decompiled or rewritten.

See [`docs/ARCHITECTURE.en.md`](ARCHITECTURE.en.md) for the full design, feature comparison and directory layout, and [`docs/PATCHING_WORKFLOW.en.md`](PATCHING_WORKFLOW.en.md) for per-platform patch baselines and maintenance workflows.
