#!/usr/bin/env bash
#
# Build a Firecracker agent rootfs with bun, node, git, and agent tooling.
# Outputs: infra/firecracker/images/agent-rootfs.ext4
#
# Uses Docker to build the aarch64 userspace, then extracts to an ext4 image.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGES_DIR="$SCRIPT_DIR/images"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-2048}"
ROOTFS_FILE="$IMAGES_DIR/agent-rootfs.ext4"
CONTAINER_NAME="fc-rootfs-builder-$$"

mkdir -p "$IMAGES_DIR"

echo "=== Building agent rootfs (${ROOTFS_SIZE_MB}MB) ==="

# Build the Docker image with all agent tooling
docker build -f "$SCRIPT_DIR/Dockerfile.rootfs" -t fc-agent-rootfs:latest "$SCRIPT_DIR" 2>&1

echo "=== Extracting filesystem to ext4 ==="

# Create empty ext4 image
dd if=/dev/zero of="$ROOTFS_FILE" bs=1M count="$ROOTFS_SIZE_MB" 2>/dev/null
mkfs.ext4 -F -L agent-rootfs "$ROOTFS_FILE" 2>/dev/null

# Create a container from the image (don't start it)
docker create --name "$CONTAINER_NAME" fc-agent-rootfs:latest /bin/true >/dev/null

# Mount the ext4 image and extract the container filesystem into it
MOUNT_DIR=$(mktemp -d)
cleanup() {
  sudo umount "$MOUNT_DIR" 2>/dev/null || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

sudo mount "$ROOTFS_FILE" "$MOUNT_DIR"
docker export "$CONTAINER_NAME" | sudo tar -xf - -C "$MOUNT_DIR" 2>/dev/null

# Set up init system for Firecracker
sudo bash -c "cat > '$MOUNT_DIR/etc/inittab'" << 'INITEOF'
::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/bin/mount -t devtmpfs dev /dev
::sysinit:/bin/mount -t tmpfs tmpfs /tmp
::sysinit:/bin/mount -t tmpfs tmpfs /run
::sysinit:/bin/hostname agent-sandbox
::sysinit:/sbin/ifconfig lo up
::respawn:-/bin/bash
INITEOF

# Ensure /dev/console exists
sudo mknod -m 622 "$MOUNT_DIR/dev/console" c 5 1 2>/dev/null || true

sudo umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "=== Rootfs ready ==="
ls -lh "$ROOTFS_FILE"
echo ""
echo "To test: copy to Colima VM and boot with Firecracker"
echo "  colima ssh -- sudo cp /dev/stdin /tmp/firecracker-test/agent-rootfs.ext4 < $ROOTFS_FILE"
