#!/usr/bin/env python3
"""Reference client for the iScooter / MiniRobot BLE frame format (bleak).

Build and send a write command over one of the known GATT profiles. The frame is:

    55 AA <LEN> <CMD> <SUB> <REG> <payload LE...> <CK_LO> <CK_HI>

with LEN = payload_len + 2 and CK = one's complement of the 16-bit byte sum from offset 2.
A write is CMD 0x20 SUB 0x03; a read is CMD 0x06 SUB 0x01. Speed setters use kmh * mul + add.

Usage:
    python iscooter_speed.py <device-address> --reg 0x7d --kmh 25 --mul 1000 --add 2000
    python iscooter_speed.py <device-address> --reg 0x72 --value 1        # cruise/limit on
Requires: pip install bleak
"""
import argparse, asyncio

# GATT profiles the app supports; the first that exposes both characteristics is used.
PROFILES = [
    ("6e400001-b5a3-f393-e0a9-e50e24dcca9e", "6e400002-b5a3-f393-e0a9-e50e24dcca9e", "6e400003-b5a3-f393-e0a9-e50e24dcca9e"),
    ("0000ae00-0000-1000-8000-00805f9b34fb", "0000ae01-0000-1000-8000-00805f9b34fb", "0000ae02-0000-1000-8000-00805f9b34fb"),
    ("0000ffe0-0000-1000-8000-00805f9b34fb", "0000fff3-0000-1000-8000-00805f9b34fb", "0000fff4-0000-1000-8000-00805f9b34fb"),
    ("0000fff0-0000-1000-8000-00805f9b34fb", "0000fff2-0000-1000-8000-00805f9b34fb", "0000fff1-0000-1000-8000-00805f9b34fb"),
    ("0000fff0-0000-1000-8000-00805f9b34fb", "0000fff3-0000-1000-8000-00805f9b34fb", "0000fff7-0000-1000-8000-00805f9b34fb"),
]


def checksum16(frame, start=2):
    s = 0
    for b in frame[start:]:
        s = (s + b) & 0xFFFF
    return (~s) & 0xFFFF


def build_frame(cmd, sub, reg, payload=b"", xor_key=0):
    body = bytes([0x55, 0xAA, len(payload) + 2, cmd, sub, reg]) + bytes(payload)
    ck = checksum16(body, 2)
    frame = body + bytes([ck & 0xFF, (ck >> 8) & 0xFF])
    if xor_key:
        frame = bytes(b ^ xor_key for b in frame)
    return frame


def write_reg(reg, value16, xor_key=0):
    return build_frame(0x20, 0x03, reg, bytes([value16 & 0xFF, (value16 >> 8) & 0xFF]), xor_key)


async def main():
    from bleak import BleakClient
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--reg", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--value", type=lambda x: int(x, 0), default=None)
    ap.add_argument("--kmh", type=float, default=None)
    ap.add_argument("--mul", type=int, default=1000)
    ap.add_argument("--add", type=int, default=0)
    ap.add_argument("--xor", type=lambda x: int(x, 0), default=0)
    a = ap.parse_args()

    raw = a.value if a.value is not None else round((a.kmh or 0) * a.mul + a.add)
    frame = write_reg(a.reg, raw & 0xFFFF, a.xor)

    async with BleakClient(a.address) as client:
        services = client.services
        write_uuid = None
        for svc_u, wr_u, _nt_u in PROFILES:
            svc = services.get_service(svc_u)
            if svc and svc.get_characteristic(wr_u):
                write_uuid = wr_u
                break
        if not write_uuid:
            raise SystemExit("no matching GATT profile on this device")
        print("TX", frame.hex(" "))
        await client.write_gatt_char(write_uuid, frame, response=False)


if __name__ == "__main__":
    asyncio.run(main())
