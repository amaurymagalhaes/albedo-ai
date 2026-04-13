pub struct VadEngine;
impl VadEngine {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(VadEngine)
    }
}
