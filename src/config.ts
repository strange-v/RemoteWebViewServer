export type DeviceCfgRaw = {
  id: string
  url: string
  w?: number
  h?: number
}

export type DeviceCfg = {
  id: string
  url: string
  w: number
  h: number
}

function parseJsonMap(value: string): Map<string, DeviceCfg> {
  const result = new Map<string, DeviceCfg>()
  const devices = JSON.parse(value) as DeviceCfgRaw[]
  
  for (const device of devices) {
    const defaultWidth = parseInt(process.env.DEFAULT_VIEWPORT_W ? process.env.DEFAULT_VIEWPORT_W: '480', 10)
    const defaultHeight = parseInt(process.env.DEFAULT_VIEWPORT_H ? process.env.DEFAULT_VIEWPORT_H: '480', 10)

    if (!device?.id || !device?.url) continue
    
    const deviceCfg = {
      id: device.id,
      url: device.url,
      w: device.w || defaultWidth,
      h: device.h || defaultHeight
    } as DeviceCfg

    result.set(device.id, deviceCfg)
  }

  return result
}

export function loadDeviceMap(): Map<string, DeviceCfg> {
  const result = new Map<string, DeviceCfg>()
  const json = process.env.DEVICE_MAP_JSON || '[ { "id": "living-room", "url": "http://172.16.0.252:8123/dashboard-mobile/0" } ]'

  if (json && json.trim()) {
    try {
      for (const [k, v] of parseJsonMap(json)) result.set(k, v)
    } catch (e) {
      console.error('[cfg] DEVICE_MAP_JSON parse error:', (e as Error).message)
    }
  }

  return result
}

export function resolveDevice(devMap: Map<string, DeviceCfg>, id: string): DeviceCfg | undefined {
  return devMap.get(id)
}
