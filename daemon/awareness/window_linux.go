//go:build linux

package awareness

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type ActiveWindow struct {
	Title   string
	AppName string
	AppPath string
	PID     uint32
}

func GetActiveWindow() (*ActiveWindow, error) {
	result := &ActiveWindow{}

	titleOut, err := exec.Command("xdotool", "getactivewindow", "getwindowname").Output()
	if err != nil {
		return result, nil
	}
	result.Title = strings.TrimSpace(string(titleOut))

	pidOut, err := exec.Command("xdotool", "getactivewindow", "getwindowpid").Output()
	if err != nil {
		return result, nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidOut)))
	if err != nil {
		return result, nil
	}
	result.PID = uint32(pid)

	exePath, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err == nil {
		result.AppPath = exePath
		result.AppName = filepath.Base(exePath)
	}

	commData, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err == nil {
		comm := strings.TrimSpace(string(commData))
		if comm != "" {
			result.AppName = comm
		}
	}

	return result, nil
}
