package awareness

import (
	"sync"
	"time"

	pb "albedo-ai/daemon/proto"
)

type Collector struct {
	mu            sync.RWMutex
	metrics       *SystemMetrics
	clipboard     *ClipboardMonitor
	clipboardText string
	activeWindow  *ActiveWindow
	stopCh        chan struct{}
}

func NewCollector() *Collector {
	return &Collector{
		clipboard:    NewClipboardMonitor(),
		metrics:      &SystemMetrics{},
		activeWindow: &ActiveWindow{},
	}
}

func (c *Collector) Start() {
	c.stopCh = make(chan struct{})
	go c.metricsLoop()
	go c.clipboardLoop()
	go c.windowLoop()
}

func (c *Collector) Stop() {
	if c.stopCh != nil {
		close(c.stopCh)
	}
}

func (c *Collector) metricsLoop() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			m, _ := CollectMetrics()
			if m != nil {
				c.mu.Lock()
				c.metrics = m
				c.mu.Unlock()
			}
		}
	}
}

func (c *Collector) clipboardLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			content, _, _ := c.clipboard.Read()
			c.mu.Lock()
			c.clipboardText = content
			c.mu.Unlock()
		}
	}
}

func (c *Collector) windowLoop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			w, _ := GetActiveWindow()
			if w != nil {
				c.mu.Lock()
				c.activeWindow = w
				c.mu.Unlock()
			}
		}
	}
}

func (c *Collector) Snapshot() (*pb.AwarenessSnapshot, error) {
	c.mu.RLock()
	metrics := c.metrics
	clipboardContent := c.clipboardText
	window := c.activeWindow
	c.mu.RUnlock()

	if window == nil {
		window = &ActiveWindow{}
	}
	if metrics == nil {
		metrics = &SystemMetrics{}
	}

	return &pb.AwarenessSnapshot{
		ActiveWindow: &pb.ActiveWindow{
			Title:   window.Title,
			AppName: window.AppName,
			AppPath: window.AppPath,
			Pid:     window.PID,
		},
		Metrics: &pb.SystemMetrics{
			CpuPercent:     metrics.CPUPercent,
			RamPercent:     metrics.RAMPercent,
			DiskPercent:    metrics.DiskPercent,
			NetworkMbpsIn:  metrics.NetMbpsIn,
			NetworkMbpsOut: metrics.NetMbpsOut,
			TopProcesses:   toProtoProcesses(metrics.TopProcesses),
		},
		ClipboardContent: clipboardContent,
		TimestampMs:      uint64(time.Now().UnixMilli()),
	}, nil
}

func (c *Collector) CaptureScreen(req *pb.ScreenCaptureRequest) (*pb.ScreenCaptureResponse, error) {
	var data []byte
	var w, h int
	var err error

	if req.Region == "active_window" {
		quality := int(req.Quality)
		if quality <= 0 {
			quality = 85
		}
		data, w, h, err = CaptureActiveWindowJPEG(quality)
	} else {
		switch req.Format {
		case "png":
			data, w, h, err = CaptureScreenPNG()
		default:
			quality := int(req.Quality)
			if quality <= 0 {
				quality = 85
			}
			data, w, h, err = CaptureScreenJPEG(quality)
		}
	}

	if err != nil {
		return nil, err
	}

	return &pb.ScreenCaptureResponse{
		ImageData: data,
		Width:     uint32(w),
		Height:    uint32(h),
	}, nil
}

func toProtoProcesses(procs []ProcessInfo) []*pb.ProcessInfo {
	out := make([]*pb.ProcessInfo, len(procs))
	for i, p := range procs {
		out[i] = &pb.ProcessInfo{
			Name:       p.Name,
			Pid:        p.PID,
			CpuPercent: p.CPUPercent,
			RamMb:      p.RAMMB,
		}
	}
	return out
}
