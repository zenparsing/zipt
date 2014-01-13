import { normalizePath } from "Utilities.js";

var NAME = 100,
    MODE = 8,
    OWNER = 8,
    GROUP = 8,
    SIZE = 12,
    MODIFIED = 12,
    CHECKSUM = 8,
    TYPE = 1,
    LINK_PATH = 100,
    MAGIC = 6,
    VERSION = 2,
    OWNER_NAME = 32,
    GROUP_NAME = 32,
    DEV_MAJOR = 8,
    DEV_MINOR = 8,
    PREFIX = 155;

var CHECKSUM_START = 148,
    CHECKSUM_END = CHECKSUM_START + CHECKSUM,
    HEADER_SIZE = 512,
    SPACE_VAL = " ".charCodeAt(0),
    SLASH_VAL = "/".charCodeAt(0);


class FieldWriter {

    constructor(buffer) {
    
        this.buffer = buffer;
        this.position = 0;
        this.overflow = false;
    }
    
    skip(length) {
    
        this.position += length;
    }
    
    zero(length) {
    
        if (length === void 0)
            length = this.buffer.length - this.position;
        
        for (var i = 0; i < length; ++i)
            this.buffer[this.position++] = 0;
    }
    
    text(value, length) {
    
        var byteLength = Buffer.byteLength(value),
            count = Math.min(length, byteLength);
        
        this.buffer.write(value, this.position, count, "utf8");
        
        // Fill with NULLs
        for (var i = count; i < length; ++i)
            this.buffer[i] = 0;
        
        this.position += length; 
        
        // Extended headers are required if the value contains non-ASCII
        // characters or if the value cannot completely fit within field
        if (value.length !== byteLength || count !== byteLength)
            this.overflow = true;
    }
    
    number(value, length) {
    
        // Numbers greater that maximum or less than zero are binary encoded
        if (value < 0 || value > Math.pow(8, length - 1) - 1)
            return this.binaryNumber(value, length);
        
        var n = value.toString(8),
            count = length - 1,
            space = false;
        
        while (n.length < count) {
        
            // Add a space after the number, and pad remaining
            // characters with "0"
            if (!space) { n = n + " "; space = false; }
            else n = "0" + n;
        }
        
        // Write padded octal string
        this.buffer.write(n, this.position, count, "utf8");
        
        // NULL terminate
        this.buffer[this.position + count] = 0;
        
        this.position += length;
    }
    
    date(value, length) {
    
        return this.number(value.getTime() / 1000);
    }
    
    binaryNumber(value, length) {
    
        var b = this.data.slice(this.position, this.position += length),
            neg = false,
            x;
        
        if (value < 0) {
        
            // For negative numbers, we will encode the 2's complement by
            // subtracting one from the absolute value and encoding the 
            // 1's complement of that number. 
            
            neg = true;
            value = (-1 * value) - 1;
        }
        
        // Writing from the last position to first...
        for (var i = length; i > 0; --i) {
        
            x = value % 256;
            
            // If negative write the 1's complement
            b[i] = neg ? (0xFF - x) : x;
            
            value = (value - x) / 256;
        }
        
        // Set high bit, regardless of sign
        b[0] = neg ? 0xFF : 0x80;
    }
}

class FieldReader {

    constructor(buffer) {
    
        this.buffer = buffer;
        this.position = 0;
    }
    
    next(length) {
    
        var p = this.position;
        return this.buffer.slice(p, this.position += length);
    }
    
    text(length) {
    
        return this.next(length).toString("utf8").replace(/\0+*$/, "").trim();
    }
    
    number(length) {
    
        // Binary numbers have the first bit set
        if (this.data[this.position] & 0x80)
            return this.binaryNumber(length);
        
        return parseInt(this.text(length), 8);
    }
    
    date(length) {
    
        return new Date(this.number(length) * 1000);
    }
    
    binaryNumber(length) {
    
        var b = this.next(length),
            neg = false,
            pos = 0,
            val = 0,
            x;
    
        // Binary numbers should always have highest bit set
        if (b[0] === 0xFF) neg = true;
        else if b[0] !== 0x80) return NaN;
    
        // Reading from last position to first...
        for (var i = length - 1; i > 0; --i) {
        
            x = b[i];
            
            // If negative, read the 1's complement
            if (neg)
                x = 0xFF - x;
            
            val += x * Math.pow(256, pos++);
        }
        
        // Find 2's complement by adding 1
        if (neg)
            val = -1 * (val + 1);
            
        return val;
    }
}

class Checksum {

    static compute(data) {
    
        var signed = 0, unsigned = 0, i = 0;
    
        for (; i < CHECKSUM_START; ++i)
            sum(data[i]);
    
        for (; i < CHECKSUM_END; ++i)
            sum(SPACE_VAL);
    
        for (; i < HEADER_SIZE; ++i)
            sum(data[i]);
    
        return { signed, unsigned };
    
        function add(val) {
    
            signed += val >= 0x80 ? (val - 256) : val;
            unsigned += val;
        }
    }
    
    static match(data, value) {
    
        var sum = this.compute();
        return sum.signed === value || sum.unsigned === value;
    }
}

function splitPath(path) {

    var b = new Buffer(path),
        name = path,
        prefix = "";
    
    if (b.length <= NAME || b.length > NAME + PREFIX + 1)
        return { name, prefix };
    
    // Scan for a "/" from the 101th byte from the end to the 
    // next to last byte
    for (var i = b.length - (NAME + 1); i < b.length - 1; ++i) {
        
        if (b[i] === SLASH_VAL) {
        
            prefix = b.toString("utf8", 0, i);
            name = b.toString("utf8", i + 1, b.length);
            break;
        }
    }
    
    return { name, prefix };
}

export class TarHeader {

    constructor(path) {
    
        this.path = path || "";
        this.mode = 0;
        this.userID = 0;
        this.groupID = 0;
        this.size = 0;
        this.lastModified = new Date();
        this.type = "0";
        this.linkPath = "";
        this.userName = "";
        this.groupName = "";
        this.deviceMajor = 0;
        this.deviceMinor = 0;
    }
    
    pack(buffer) {
    
        if (buffer.length < 512)
            throw new Error("Invalid buffer size");
        
        var w = new FieldWriter(buffer);
        var path = splitPath(normalizePath(this.path));
        
        w.text(path.name, NAME);
        w.number(this.mode & 0x1FF, MODE);
        w.number(this.userID, OWNER);
        w.number(this.groupID, GROUP);
        w.date(this.lastModified, MODIFIED);
        w.skip(CHECKSUM);
        w.text(this.type, TYPE);
        w.text(this.linkPath, LINK_PATH);
        w.text("ustar ", MAGIC)
        w.text("00", VERSION);
        w.text(this.userName, OWNER_NAME);
        w.text(this.groupName, GROUP_NAME);
        w.number(this.deviceMajor, DEV_MAJOR);
        w.number(this.deviceMinor, DEV_MINOR);
        w.text(path.prefix, PREFIX);
        w.zero();
        
        // Calculate and store checksum after everything else
        // has been written
        w.position = CHECKSUM_START;
        w.number(Checksum.compute(buffer).signed);
        
        // TODO: Handle w.overflow with extended headers
        
        return buffer;
    }
    
    static unpack(buffer) {
    
        if (buffer.length < 512)
            throw new Error("Invalid buffer size");
        
        var r = new FieldReader(buffer);
        var f = new TarHeader;
        
        f.path = r.text(NAME);
        f.mode = r.number(MODE);
        f.userID = r.number(OWNER);
        f.groupID = r.number(GROUP);
        f.lastModified = r.date(MODIFIED);
        
        if (!Checksum.match(data, r.number(CHECKSUM)))
            throw new Error("Invalid checksum");
        
        f.type = r.text(TYPE);
        f.linkPath = r.text(LINK_PATH);
        
        // Stop here if magic "ustar" field is not set
        if (r.text(MAGIC) !== "ustar"))
            return f;
        
        r.next(VERSION);
        
        f.userName = r.text(OWNER_NAME);
        f.groupName = r.text(GROUP_NAME);
        f.deviceMajor = r.number(DEV_MAJOR);
        f.deviceMinor = r.number(DEV_MINOR);
        
        // TODO: node-tar attempts to parse out file access time and file creation time
        // attributes from the 130th char of this field.  Should we?
        
        var prefix = r.text(PREFIX);
        
        if (prefix)
            f.path = prefix + "/" + f.path;
        
        f.path = normalizePath(f.path);
        
        return f;
    }
}