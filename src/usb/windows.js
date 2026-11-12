/**
 * Windows USB enumeration via SetupAPI + koffi (UNTESTED: written to the
 * documented Win32 API, never run). Read-only.
 */

import koffi from 'koffi';

import { UsbError, makeDevice, parseWindowsInstanceId } from './devices.js';

const DIGCF_PRESENT = 0x2;
const DIGCF_DEVICEINTERFACE = 0x10;
const SPDRP_DEVICEDESC = 0x0;
const SPDRP_FRIENDLYNAME = 0xc;
const INVALID_HANDLE = 0xffffffffffffffffn;

let api = null;

function load() {
  if (api) return api;
  const GUID = koffi.struct('PASEBOON_GUID', {
    Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8),
  });
  const DEVINFO = koffi.struct('PASEBOON_SP_DEVINFO_DATA', {
    cbSize: 'uint32', ClassGuid: GUID, DevInst: 'uint32', Reserved: 'uintptr',
  });
  const lib = koffi.load('setupapi.dll');
  const handle = koffi.pointer(koffi.opaque());
  api = {
    DEVINFO,
    // GUID_DEVINTERFACE_USB_DEVICE {A5DCBF10-6530-11D2-901F-00C04FB951ED}
    guid: { Data1: 0xa5dcbf10, Data2: 0x6530, Data3: 0x11d2, Data4: [0x90, 0x1f, 0x00, 0xc0, 0x4f, 0xb9, 0x51, 0xed] },
    getClassDevs: lib.func('__stdcall', 'SetupDiGetClassDevsW', handle, [koffi.pointer(GUID), 'str16', 'void *', 'uint32']),
    enumInfo: lib.func('__stdcall', 'SetupDiEnumDeviceInfo', 'int', [handle, 'uint32', koffi.inout(koffi.pointer(DEVINFO))]),
    instanceId: lib.func('__stdcall', 'SetupDiGetDeviceInstanceIdW', 'int',
      [handle, koffi.pointer(DEVINFO), koffi.out(koffi.pointer('uint8')), 'uint32', 'void *']),
    regProp: lib.func('__stdcall', 'SetupDiGetDeviceRegistryPropertyW', 'int',
      [handle, koffi.pointer(DEVINFO), 'uint32', 'void *', koffi.out(koffi.pointer('uint8')), 'uint32', 'void *']),
    destroy: lib.func('__stdcall', 'SetupDiDestroyDeviceInfoList', 'int', [handle]),
  };
  return api;
}

const utf16 = (buf) => {
  const s = buf.toString('utf16le');
  const end = s.indexOf('\0');
  return end < 0 ? s : s.slice(0, end);
};

export function windowsDevices() {
  let a;
  try {
    a = load();
  } catch (err) {
    throw new UsbError(`SetupAPI unavailable: ${err.message}`);
  }
  const h = a.getClassDevs(a.guid, null, null, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (!h || koffi.address(h) === INVALID_HANDLE) throw new UsbError('SetupDiGetClassDevs failed');
  const out = [];
  try {
    for (let index = 0; ; index += 1) {
      const info = { cbSize: koffi.sizeof(a.DEVINFO) };
      if (!a.enumInfo(h, index, info)) break;
      const idBuf = Buffer.alloc(1024);
      if (!a.instanceId(h, info, idBuf, idBuf.length / 2, null)) continue;
      const parsed = parseWindowsInstanceId(utf16(idBuf));
      if (!parsed) continue;
      let name = '';
      for (const prop of [SPDRP_FRIENDLYNAME, SPDRP_DEVICEDESC]) {
        const nameBuf = Buffer.alloc(512);
        if (a.regProp(h, info, prop, null, nameBuf, nameBuf.length, null)) {
          name = utf16(nameBuf);
          break;
        }
      }
      out.push(makeDevice(parsed.vendorId, parsed.productId, parsed.serial, name));
    }
  } finally {
    a.destroy(h);
  }
  return out;
}
