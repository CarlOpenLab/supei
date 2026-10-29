//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// prepareCmd puts the child in its own process group so cancellation can
// kill the whole tree (npm/pnpm spawn grandchildren).
func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
