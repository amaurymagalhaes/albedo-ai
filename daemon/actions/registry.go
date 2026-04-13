package actions

type Registry struct{}

func NewRegistry() *Registry       { return &Registry{} }
func RegisterDefaults(_ *Registry) {}
