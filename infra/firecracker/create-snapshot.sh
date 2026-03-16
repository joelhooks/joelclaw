#!/usr/bin/env bash
#
# Create a Firecracker snapshot from the agent rootfs.
# Run inside the Colima VM (needs /dev/kvm).
#
# Prereqs:
#   - /tmp/firecracker-test/vmlinux (kernel)
#   - /tmp/firecracker-test/agent-rootfs.ext4 (rootfs)
#   - firecracker binary in PATH
#
# Outputs:
#   - /tmp/firecracker-test/snapshots/vm.snap (11KB state)
#   - /tmp/firecracker-test/snapshots/vm.mem  (512MB memory)
#
set -e

KERNEL="/tmp/firecracker-test/vmlinux"
ROOTFS="/tmp/firecracker-test/agent-rootfs.ext4"
SNAP_DIR="/tmp/firecracker-test/snapshots"
SOCKET="/tmp/fc-snap-create.socket"

mkdir -p "$SNAP_DIR"
rm -f "$SOCKET"
pkill -f "firecracker" 2>/dev/null || true
sleep 1

echo "Booting microVM..."
firecracker --api-sock "$SOCKET" &
FC_PID=$!
sleep 1

curl -sf --unix-socket "$SOCKET" -X PUT http://localhost/boot-source \
  -H "Content-Type: application/json" \
  -d "{\"kernel_image_path\":\"$KERNEL\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off\"}" >/dev/null

curl -sf --unix-socket "$SOCKET" -X PUT http://localhost/drives/rootfs \
  -H "Content-Type: application/json" \
  -d "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$ROOTFS\",\"is_root_device\":true,\"is_read_only\":false}" >/dev/null

curl -sf --unix-socket "$SOCKET" -X PUT http://localhost/machine-config \
  -H "Content-Type: application/json" \
  -d "{\"vcpu_count\":2,\"mem_size_mib\":512}" >/dev/null

curl -sf --unix-socket "$SOCKET" -X PUT http://localhost/actions \
  -H "Content-Type: application/json" \
  -d "{\"action_type\":\"InstanceStart\"}" >/dev/null

echo "Waiting for init (4s)..."
sleep 4

echo "Pausing VM..."
curl -sf --unix-socket "$SOCKET" -X PATCH http://localhost/vm \
  -H "Content-Type: application/json" \
  -d '{"state":"Paused"}' >/dev/null

echo "Creating snapshot..."
curl -sf --unix-socket "$SOCKET" -X PUT http://localhost/snapshot/create \
  -H "Content-Type: application/json" \
  -d "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$SNAP_DIR/vm.snap\",\"mem_file_path\":\"$SNAP_DIR/vm.mem\"}" >/dev/null

kill $FC_PID 2>/dev/null
wait $FC_PID 2>/dev/null

echo ""
echo "Snapshot created:"
ls -lh "$SNAP_DIR/"
echo ""
echo "Restore command:"
echo "  firecracker --api-sock /tmp/fc.socket"
echo "  curl --unix-socket /tmp/fc.socket -X PUT http://localhost/snapshot/load \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"snapshot_path\":\"$SNAP_DIR/vm.snap\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$SNAP_DIR/vm.mem\"},\"enable_diff_snapshots\":false,\"resume_vm\":true}'"
