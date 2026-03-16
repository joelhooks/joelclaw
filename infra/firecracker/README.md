# Firecracker MicroVM Infrastructure

ADR-0230: Firecracker MicroVM Agent Sandboxes

## Setup

### Prerequisites

- Colima with `nestedVirtualization: true` (requires VZ framework, Apple Silicon)
- `/dev/kvm` accessible inside the Colima VM

### Guest Images

Download from Firecracker CI (not committed to git):

```bash
BUILD="20260107-89702a77e4c2-0"
mkdir -p infra/firecracker/images
curl -sL "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/${BUILD}/aarch64/vmlinux-6.1.155" \
  -o infra/firecracker/images/vmlinux-6.1.155
curl -sL "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/${BUILD}/aarch64/ubuntu-24.04.squashfs" \
  -o infra/firecracker/images/ubuntu-24.04.squashfs
```

### Firecracker Binary

```bash
FC_VERSION="v1.15.0"
curl -sL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-aarch64.tgz" \
  -o /tmp/firecracker-${FC_VERSION}-aarch64.tgz
tar xzf /tmp/firecracker-${FC_VERSION}-aarch64.tgz
# Install inside Colima VM:
colima ssh -- sudo cp release-${FC_VERSION}-aarch64/firecracker-${FC_VERSION}-aarch64 /usr/local/bin/firecracker
colima ssh -- sudo chmod +x /usr/local/bin/firecracker
```

## Files

| File | Purpose |
|------|---------|
| `stages.json` | 10-step execution DAG for workload planner |
| `images/` | Guest kernel + rootfs (gitignored, downloaded from CI) |
| `README.md` | This file |

## Architecture

```
macOS (M4 Pro) → Colima VM (VZ, aarch64, nested virt) → /dev/kvm → Firecracker microVMs
```
