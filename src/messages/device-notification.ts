import { BaseMessage } from "./base-message";

export class DeviceNotificationMessage extends BaseMessage {
    public static readonly Id = 0x3c;

    public payloadSize: number | undefined;
    public devices: any[] = [];

    public deserialize(data: Uint8Array) {
        const view = new DataView(data.buffer);

        if (data.length < 3) {
            throw new Error(`Device notification header is truncated (${data.length} bytes)`);
        }

        this.payloadSize = view.getUint16(1, true);
        const payloadEnd = 3 + this.payloadSize;
        if (payloadEnd > data.length) {
            throw new Error(
                `Device notification declares ${this.payloadSize} payload bytes, but only ${data.length - 3} are available`,
            );
        }

        let offset = 3;

        while (offset < payloadEnd) {
            const type = view.getUint8(offset);
            const recordSize = DEVICE_RECORD_SIZES.get(type);
            if (recordSize === undefined) {
                throw new Error(
                    `Unknown device notification type 0x${type.toString(16).padStart(2, "0")} at offset ${offset}`,
                );
            }
            if (offset + recordSize > payloadEnd) {
                throw new Error(
                    `Device notification type 0x${type.toString(16).padStart(2, "0")} at offset ${offset} requires ${recordSize} bytes, but only ${payloadEnd - offset} remain`,
                );
            }

            switch (type) {
                case 0x00:
                    offset = this.parseBattery(view, offset);
                    break;

                case 0x01:
                    offset = this.parseImu(view, offset);
                    break;

                case 0x02:
                    offset = this.parseMatrix(view, offset);
                    break;

                case 0x0a:
                    offset = this.parseMotor(view, offset);
                    break;

                case 0x0b:
                    offset = this.parseForceSensor(view, offset);
                    break;

                case 0x0c:
                    offset = this.parseColorSensor(view, offset);
                    break;

                case 0x0d:
                    offset = this.parseDistanceSensor(view, offset);
                    break;

                case 0x0e:
                    offset = this.parse3x3Matrix(view, offset);
                    break;
            }
        }
    }

    private parseBattery(view: DataView, offset: number): number {
        const level = view.getUint8(offset + 1);

        this.devices.push({
            type: "battery",
            level,
        });

        return offset + 2;
    }

    private parseImu(view: DataView, offset: number): number {
        const hubFaceUp = view.getUint8(offset + 1);
        const yawFace = view.getUint8(offset + 2);
        const yaw = view.getInt16(offset + 3, true);
        const pitch = view.getInt16(offset + 5, true);
        const roll = view.getInt16(offset + 7, true);

        const accX = view.getInt16(offset + 9, true);
        const accY = view.getInt16(offset + 11, true);
        const accZ = view.getInt16(offset + 13, true);

        const gyroX = view.getInt16(offset + 15, true);
        const gyroY = view.getInt16(offset + 17, true);
        const gyroZ = view.getInt16(offset + 19, true);

        this.devices.push({
            type: "imu",
            hubFaceUp,
            yawFace,
            yaw,
            pitch,
            roll,
            accX,
            accY,
            accZ,
            gyroX,
            gyroY,
            gyroZ,
        });

        return offset + 21;
    }

    private parseMatrix(view: DataView, offset: number): number {
        const pixels: number[] = [];

        for (let i = 0; i < 25; i++) {
            pixels.push(view.getUint8(offset + 1 + i));
        }

        this.devices.push({
            type: "matrix5x5",
            pixels,
        });

        return offset + 26;
    }

    private parseMotor(view: DataView, offset: number): number {
        const port = view.getUint8(offset + 1);
        const deviceType = view.getUint8(offset + 2);
        const absPosition = view.getInt16(offset + 3, true);
        const power = view.getInt16(offset + 5, true);
        const speed = view.getInt8(offset + 7);
        const position = view.getInt32(offset + 8, true);

        this.devices.push({
            type: "motor",
            port,
            deviceType,
            absPosition,
            power,
            speed,
            position,
        });

        return offset + 12;
    }

    private parseForceSensor(view: DataView, offset: number): number {
        const port = view.getUint8(offset + 1);
        const value = view.getUint8(offset + 2);
        const pressed = view.getUint8(offset + 3) === 0x01;

        this.devices.push({
            type: "force",
            port,
            value,
            pressed,
        });

        return offset + 4;
    }

    private parseColorSensor(view: DataView, offset: number): number {
        const port = view.getUint8(offset + 1);
        const color = view.getInt8(offset + 2);
        const reflected = view.getUint8(offset + 3);
        const red = view.getUint16(offset + 4, true);
        const green = view.getUint16(offset + 6, true);
        const blue = view.getUint16(offset + 8, true);

        this.devices.push({
            type: "color",
            port,
            color,
            colorName: COLOR_NAMES.get(color) ?? "unknown",
            reflected,
            red,
            green,
            blue,
        });

        return offset + 10;
    }

    private parseDistanceSensor(view: DataView, offset: number): number {
        const port = view.getUint8(offset + 1);
        const distance = view.getInt16(offset + 2, true);

        this.devices.push({
            type: "distance",
            port,
            distance,
        });

        return offset + 4;
    }

    private parse3x3Matrix(view: DataView, offset: number): number {
        const port = view.getUint8(offset + 1);
        const pixels: number[] = [];

        for (let i = 0; i < 9; i++) {
            pixels.push(view.getUint8(offset + 2 + i));
        }

        this.devices.push({
            type: "matrix3x3",
            port,
            pixels,
        });

        return offset + 11;
    }
}

const DEVICE_RECORD_SIZES = new Map<number, number>([
    [0x00, 2],
    [0x01, 21],
    [0x02, 26],
    [0x0a, 12],
    [0x0b, 4],
    [0x0c, 10],
    [0x0d, 4],
    [0x0e, 11],
]);

const COLOR_NAMES = new Map<number, string>([
    [-1, "unknown"],
    [0, "black"],
    [1, "magenta"],
    [2, "purple"],
    [3, "blue"],
    [4, "azure"],
    [5, "turquoise"],
    [6, "green"],
    [7, "yellow"],
    [8, "orange"],
    [9, "red"],
    [10, "white"],
]);
