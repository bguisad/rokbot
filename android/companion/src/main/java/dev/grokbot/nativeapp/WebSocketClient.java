package dev.grokbot.nativeapp;

import android.util.Base64;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

public class WebSocketClient {
    public interface Listener {
        void onOpen(String negotiatedProtocol);
        void onTextMessage(String text);
        void onClosed(int code, String reason);
        void onError(Throwable error);
    }

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final URI mUri;
    private final String mSubprotocol;
    private final String mOrigin;
    private final Listener mListener;
    private final SecureRandom mRandom = new SecureRandom();
    private final Object mWriteLock = new Object();
    private final java.util.concurrent.ExecutorService mWriteExec =
        java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "grokbot-ws-writer");
            t.setDaemon(true);
            return t;
        });

    private Socket mSocket;
    private OutputStream mOut;
    private volatile boolean mClosed = false;
    private volatile boolean mOpen = false;
    private Thread mReadThread;

    public WebSocketClient(String url, String subprotocol, Listener listener) {
        this(url, subprotocol, null, listener);
    }

    public WebSocketClient(String url, String subprotocol, String origin, Listener listener) {
        mUri = URI.create(url);
        mSubprotocol = subprotocol;
        mOrigin = origin;
        mListener = listener;
    }

    public void connect() {
        mReadThread = new Thread(this::run, "grokbot-ws-client");
        mReadThread.setDaemon(true);
        mReadThread.start();
    }

    public boolean isOpen() {
        return mOpen && !mClosed;
    }

    public void sendText(String text) {
        if (!isOpen() || text == null) return;
        final byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
        try {
            mWriteExec.execute(() -> {
                if (!mOpen || mOut == null) return;
                try {
                    sendFrame(0x1, utf8);
                } catch (IOException e) {
                    fail(e);
                }
            });
        } catch (Throwable ignored) {}
    }

    public void close(int code, String reason) {
        if (mClosed) return;
        mClosed = true;
        final byte[] reasonBytes = reason != null ? reason.getBytes(StandardCharsets.UTF_8) : new byte[0];
        final byte[] payload = new byte[2 + reasonBytes.length];
        payload[0] = (byte) ((code >> 8) & 0xff);
        payload[1] = (byte) (code & 0xff);
        System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
        try {
            mWriteExec.execute(() -> {
                try {
                    if (mOpen && mOut != null) {
                        sendFrame(0x8, payload);
                    }
                } catch (Throwable ignored) {}
                closeSocketQuietly();
            });
        } catch (Throwable ignored) {
            closeSocketQuietly();
        }
    }

    private void run() {
        try {
            String scheme = mUri.getScheme() != null ? mUri.getScheme().toLowerCase(Locale.US) : "ws";
            boolean secure = "wss".equals(scheme);
            String host = mUri.getHost();
            int port = mUri.getPort();
            if (port == -1) port = secure ? 443 : 80;
            String path = mUri.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            if (mUri.getRawQuery() != null) path += "?" + mUri.getRawQuery();

            Socket plain = new Socket();
            plain.connect(new InetSocketAddress(host, port), 15000);
            plain.setTcpNoDelay(true);

            if (secure) {
                SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) factory.createSocket(plain, host, port, true);
                SSLParameters params = ssl.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
                ssl.startHandshake();
                mSocket = ssl;
            } else {
                mSocket = plain;
            }

            mOut = mSocket.getOutputStream();
            BufferedInputStream in = new BufferedInputStream(mSocket.getInputStream(), 16384);

            byte[] nonce = new byte[16];
            mRandom.nextBytes(nonce);
            String wsKey = Base64.encodeToString(nonce, Base64.NO_WRAP);
            String hostHeader = ((secure && port == 443) || (!secure && port == 80)) ? host : (host + ":" + port);

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(path).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(hostHeader).append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            if (mOrigin != null && !mOrigin.isEmpty()) {
                req.append("Origin: ").append(mOrigin).append("\r\n");
            }
            if (mSubprotocol != null && !mSubprotocol.isEmpty()) {
                req.append("Sec-WebSocket-Protocol: ").append(mSubprotocol).append("\r\n");
            }
            req.append("\r\n");
            mOut.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            mOut.flush();

            String statusLine = readHeaderLine(in);
            if (statusLine == null || !statusLine.contains("101")) {
                throw new IOException("WebSocket upgrade failed: " + statusLine);
            }

            String acceptHeader = null;
            String negotiatedProto = null;
            String headerLine;
            while ((headerLine = readHeaderLine(in)) != null && !headerLine.isEmpty()) {
                int colon = headerLine.indexOf(':');
                if (colon > 0) {
                    String name = headerLine.substring(0, colon).trim().toLowerCase(Locale.US);
                    String val = headerLine.substring(colon + 1).trim();
                    if ("sec-websocket-accept".equals(name)) acceptHeader = val;
                    else if ("sec-websocket-protocol".equals(name)) negotiatedProto = val;
                }
            }

            String expectedAccept = Base64.encodeToString(
                MessageDigest.getInstance("SHA-1").digest((wsKey + WS_GUID).getBytes(StandardCharsets.US_ASCII)),
                Base64.NO_WRAP
            );
            if (!expectedAccept.equals(acceptHeader)) {
                throw new IOException("Invalid Sec-WebSocket-Accept from server");
            }

            mOpen = true;
            if (mListener != null) mListener.onOpen(negotiatedProto);

            readFrames(in);
        } catch (Throwable t) {
            if (!mClosed) fail(t);
        }
    }

    private void readFrames(InputStream in) throws IOException {
        ByteArrayOutputStream fragmentBuf = new ByteArrayOutputStream();
        int fragmentOpcode = -1;

        while (!mClosed) {
            int b0 = in.read();
            if (b0 < 0) break;
            int b1 = in.read();
            if (b1 < 0) throw new EOFException("Unexpected EOF in WebSocket frame");

            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;

            if (len == 126) {
                byte[] ext = readExact(in, 2);
                len = ((ext[0] & 0xff) << 8) | (ext[1] & 0xff);
            } else if (len == 127) {
                byte[] ext = readExact(in, 8);
                len = 0;
                for (int i = 0; i < 8; i++) {
                    len = (len << 8) | (ext[i] & 0xffL);
                }
            }

            if (len > 16L * 1024 * 1024) {
                throw new IOException("WebSocket frame too large: " + len);
            }

            byte[] maskKey = masked ? readExact(in, 4) : null;
            byte[] payload = readExact(in, (int) len);
            if (maskKey != null) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= maskKey[i % 4];
                }
            }

            if (opcode == 0x8) {
                int code = 1000;
                String reason = "";
                if (payload.length >= 2) {
                    code = ((payload[0] & 0xff) << 8) | (payload[1] & 0xff);
                    if (payload.length > 2) {
                        reason = new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8);
                    }
                }
                mClosed = true;
                closeSocketQuietly();
                if (mListener != null) mListener.onClosed(code, reason);
                return;
            } else if (opcode == 0x9) {
                sendFrame(0xA, payload); // Pong
            } else if (opcode == 0xA) {
                // Ignore Pong
            } else if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
                if (opcode != 0x0) {
                    fragmentOpcode = opcode;
                    fragmentBuf.reset();
                }
                fragmentBuf.write(payload);
                if (fin) {
                    byte[] full = fragmentBuf.toByteArray();
                    fragmentBuf.reset();
                    if (fragmentOpcode == 0x1 && mListener != null) {
                        mListener.onTextMessage(new String(full, StandardCharsets.UTF_8));
                    }
                }
            }
        }
        if (!mClosed) {
            mClosed = true;
            closeSocketQuietly();
            if (mListener != null) mListener.onClosed(1006, "EOF");
        }
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        if (mOut == null) throw new IOException("WebSocket not connected");
        byte[] mask = new byte[4];
        mRandom.nextBytes(mask);
        int len = payload.length;

        ByteArrayOutputStream frame = new ByteArrayOutputStream(14 + len);
        frame.write(0x80 | (opcode & 0x0f));
        if (len <= 125) {
            frame.write(0x80 | len);
        } else if (len <= 65535) {
            frame.write(0x80 | 126);
            frame.write((len >> 8) & 0xff);
            frame.write(len & 0xff);
        } else {
            frame.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) {
                frame.write((int) ((len >> (i * 8)) & 0xff));
            }
        }
        frame.write(mask);
        byte[] masked = new byte[len];
        for (int i = 0; i < len; i++) {
            masked[i] = (byte) (payload[i] ^ mask[i % 4]);
        }
        frame.write(masked);

        synchronized (mWriteLock) {
            mOut.write(frame.toByteArray());
            mOut.flush();
        }
    }

    private void fail(Throwable t) {
        mClosed = true;
        closeSocketQuietly();
        if (mListener != null) mListener.onError(t);
    }

    private void closeSocketQuietly() {
        mOpen = false;
        try {
            if (mSocket != null) mSocket.close();
        } catch (Throwable ignored) {}
        try {
            mWriteExec.shutdown();
        } catch (Throwable ignored) {}
    }

    private static String readHeaderLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int prev = -1;
        int cur;
        while ((cur = in.read()) != -1) {
            if (cur == '\n') {
                byte[] bytes = line.toByteArray();
                int end = (bytes.length > 0 && bytes[bytes.length - 1] == '\r') ? bytes.length - 1 : bytes.length;
                return new String(bytes, 0, end, StandardCharsets.US_ASCII);
            }
            line.write(cur);
            if (line.size() > 16384) throw new IOException("HTTP header line too long");
            prev = cur;
        }
        return line.size() == 0 ? null : new String(line.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static byte[] readExact(InputStream in, int count) throws IOException {
        byte[] buf = new byte[count];
        int off = 0;
        while (off < count) {
            int n = in.read(buf, off, count - off);
            if (n < 0) throw new EOFException("Unexpected EOF reading WebSocket frame");
            off += n;
        }
        return buf;
    }
}
