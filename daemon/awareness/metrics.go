package awareness

import (
	"sort"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

type SystemMetrics struct {
	CPUPercent   float32
	RAMPercent   float32
	DiskPercent  float32
	NetMbpsIn    float32
	NetMbpsOut   float32
	TopProcesses []ProcessInfo
}

type ProcessInfo struct {
	Name       string
	PID        uint32
	CPUPercent float32
	RAMMB      float32
}

func CollectMetrics() (*SystemMetrics, error) {
	m := &SystemMetrics{}

	if percents, err := cpu.Percent(time.Second, false); err == nil && len(percents) > 0 {
		m.CPUPercent = float32(percents[0])
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		m.RAMPercent = float32(vm.UsedPercent)
	}

	if du, err := disk.Usage("/"); err == nil {
		m.DiskPercent = float32(du.UsedPercent)
	}

	if counters1, err := net.IOCounters(false); err == nil && len(counters1) > 0 {
		c1 := counters1[0]
		time.Sleep(time.Second)
		if counters2, err := net.IOCounters(false); err == nil && len(counters2) > 0 {
			c2 := counters2[0]
			bytesIn := float64(c2.BytesRecv - c1.BytesRecv)
			bytesOut := float64(c2.BytesSent - c1.BytesSent)
			m.NetMbpsIn = float32(bytesIn * 8 / 1000000)
			m.NetMbpsOut = float32(bytesOut * 8 / 1000000)
		}
	}

	if pids, err := process.Processes(); err == nil {
		var procs []ProcessInfo
		for _, p := range pids {
			name, _ := p.Name()
			cpuPct, _ := p.CPUPercent()
			memInfo, _ := p.MemoryInfo()
			var ramMB float32
			if memInfo != nil {
				ramMB = float32(memInfo.RSS) / 1024 / 1024
			}
			procs = append(procs, ProcessInfo{
				Name:       name,
				PID:        uint32(p.Pid),
				CPUPercent: float32(cpuPct),
				RAMMB:      ramMB,
			})
		}
		sort.Slice(procs, func(i, j int) bool {
			return procs[i].CPUPercent > procs[j].CPUPercent
		})
		if len(procs) > 5 {
			procs = procs[:5]
		}
		m.TopProcesses = procs
	}

	return m, nil
}
