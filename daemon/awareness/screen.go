//go:build !noscrn

package awareness

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os/exec"
	"strconv"
	"strings"
)

func CaptureScreenJPEG(quality int) (data []byte, width, height int, err error) {
	out, err := exec.Command("import", "-window", "root", "-quality", strconv.Itoa(quality), "jpeg:-").Output()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("screen capture: %w", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := img.Bounds()
	return out, bounds.Dx(), bounds.Dy(), nil
}

func CaptureScreenPNG() (data []byte, width, height int, err error) {
	out, err := exec.Command("import", "-window", "root", "png:-").Output()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("screen capture: %w", err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := img.Bounds()
	return out, bounds.Dx(), bounds.Dy(), nil
}

func CaptureActiveWindowJPEG(quality int) (data []byte, width, height int, err error) {
	winID, err := exec.Command("xdotool", "getactivewindow").Output()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("get active window: %w", err)
	}
	id := strings.TrimSpace(string(winID))

	out, err := exec.Command("import", "-window", id, "-quality", strconv.Itoa(quality), "jpeg:-").Output()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("window capture: %w", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := img.Bounds()
	return out, bounds.Dx(), bounds.Dy(), nil
}

func getActiveWindowRect() (image.Rectangle, error) {
	geomOut, err := exec.Command("xdotool", "getactivewindow", "getwindowgeometry", "--shell").Output()
	if err != nil {
		return image.Rectangle{}, err
	}
	var x, y, w, h int
	for _, line := range strings.Split(string(geomOut), "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		val := strings.TrimSpace(parts[1])
		switch strings.TrimSpace(parts[0]) {
		case "X":
			x, _ = strconv.Atoi(val)
		case "Y":
			y, _ = strconv.Atoi(val)
		case "WIDTH":
			w, _ = strconv.Atoi(val)
		case "HEIGHT":
			h, _ = strconv.Atoi(val)
		}
	}
	return image.Rect(x, y, x+w, y+h), nil
}
