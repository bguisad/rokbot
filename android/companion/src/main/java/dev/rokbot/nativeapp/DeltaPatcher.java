package dev.rokbot.nativeapp;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.zip.GZIPInputStream;

/**
 * Pure-Java streaming applier for RBDELTA1 (and legacy GBDELTA1) binary incremental patches.
 * Reconstructs a byte-exact signed APK from the installed base APK (sourceDir)
 * and a GZIP-compressed COPY/INSERT op stream.
 */
public final class DeltaPatcher {
    private static final byte[] MAGIC = new byte[]{'R', 'B', 'D', 'E', 'L', 'T', 'A', '1'};
    private static final byte[] LEGACY_MAGIC = new byte[]{'G', 'B', 'D', 'E', 'L', 'T', 'A', '1'};
    private static final int OP_EOF = 0x00;
    private static final int OP_COPY = 0x01;
    private static final int OP_INSERT = 0x02;
    private static final long MAX_TARGET_BYTES = 512L * 1024L * 1024L;

    public interface ProgressListener {
        void onProgress(long writtenBytes, long totalBytes);
    }

    private DeltaPatcher() {}

    public static void apply(File baseFile, File deltaGzipFile, File outFile, ProgressListener listener) throws IOException {
        if (baseFile == null || !baseFile.isFile()) {
            throw new IOException("Base APK file missing");
        }
        if (deltaGzipFile == null || !deltaGzipFile.isFile()) {
            throw new IOException("Delta file missing");
        }
        long actualBaseSize = baseFile.length();
        File parent = outFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }

        byte[] copyBuf = new byte[65536];
        long written = 0L;
        long lastReported = 0L;

        try (RandomAccessFile baseRaf = new RandomAccessFile(baseFile, "r");
             DataInputStream in = new DataInputStream(
                     new BufferedInputStream(
                             new GZIPInputStream(new FileInputStream(deltaGzipFile), 32768),
                             32768));
             BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(outFile), 65536)) {

            byte[] magic = new byte[8];
            in.readFully(magic);
            if (!Arrays.equals(magic, MAGIC) && !Arrays.equals(magic, LEGACY_MAGIC)) {
                throw new IOException("Invalid delta magic header");
            }

            long expectedBaseSize = in.readLong();
            long targetSize = in.readLong();
            in.readInt(); // opCount (informational)
            byte[] reserved = new byte[16];
            in.readFully(reserved);

            if (expectedBaseSize != actualBaseSize) {
                throw new IOException("Base APK size mismatch: expected=" + expectedBaseSize + " actual=" + actualBaseSize);
            }
            if (targetSize < 0 || targetSize > MAX_TARGET_BYTES) {
                throw new IOException("Invalid target APK size: " + targetSize);
            }

            boolean sawEof = false;
            while (true) {
                int op = in.read();
                if (op < 0) {
                    throw new EOFException("Unexpected EOF in delta stream");
                }
                if (op == OP_EOF) {
                    sawEof = true;
                    break;
                } else if (op == OP_COPY) {
                    long baseOff = in.readLong();
                    int len = in.readInt();
                    if (len < 0 || baseOff < 0 || baseOff + len > actualBaseSize) {
                        throw new IOException("OP_COPY out of base bounds: off=" + baseOff + " len=" + len);
                    }
                    if (written + len > targetSize) {
                        throw new IOException("OP_COPY exceeds target size");
                    }
                    baseRaf.seek(baseOff);
                    int rem = len;
                    while (rem > 0) {
                        int chunk = Math.min(rem, copyBuf.length);
                        baseRaf.readFully(copyBuf, 0, chunk);
                        out.write(copyBuf, 0, chunk);
                        rem -= chunk;
                        written += chunk;
                        if (listener != null && (written - lastReported >= 524288L || written == targetSize)) {
                            lastReported = written;
                            listener.onProgress(written, targetSize);
                        }
                    }
                } else if (op == OP_INSERT) {
                    int len = in.readInt();
                    if (len < 0 || written + len > targetSize) {
                        throw new IOException("OP_INSERT invalid length: " + len);
                    }
                    int rem = len;
                    while (rem > 0) {
                        int chunk = Math.min(rem, copyBuf.length);
                        in.readFully(copyBuf, 0, chunk);
                        out.write(copyBuf, 0, chunk);
                        rem -= chunk;
                        written += chunk;
                        if (listener != null && (written - lastReported >= 524288L || written == targetSize)) {
                            lastReported = written;
                            listener.onProgress(written, targetSize);
                        }
                    }
                } else {
                    throw new IOException("Unknown delta opcode: 0x" + Integer.toHexString(op));
                }
            }

            if (!sawEof) {
                throw new IOException("Delta stream missing OP_EOF");
            }
            out.flush();
            if (written != targetSize) {
                throw new IOException("Reconstructed size mismatch: expected=" + targetSize + " actual=" + written);
            }
        } catch (IOException e) {
            outFile.delete();
            throw e;
        }
    }
}
