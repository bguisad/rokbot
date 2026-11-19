package dev.grokbot.nativeapp;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Self-contained read-only ContentProvider serving staged APK updates from filesDir/updates/
 * to Android's system PackageInstaller without requiring AndroidX FileProvider XML resources.
 */
public class ApkUpdateProvider extends ContentProvider {
    public static final String AUTHORITY_SUFFIX = ".grokbot.updateprovider";
    private static final String MIME_APK = "application/vnd.android.package-archive";

    public static Uri uriFor(Context context, File file) {
        String authority = context.getPackageName() + AUTHORITY_SUFFIX;
        return new Uri.Builder()
                .scheme("content")
                .authority(authority)
                .appendPath("updates")
                .appendPath(file.getName())
                .build();
    }

    private File resolveFile(Uri uri) throws FileNotFoundException {
        Context ctx = getContext();
        if (ctx == null || uri == null) {
            throw new FileNotFoundException("Invalid context or URI");
        }
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches("^[A-Za-z0-9._-]+\\.apk$")) {
            throw new FileNotFoundException("Invalid APK filename");
        }
        File dir = new File(ctx.getFilesDir(), "updates");
        File file = new File(dir, name);
        try {
            String canonDir = dir.getCanonicalPath();
            String canonFile = file.getCanonicalPath();
            if (!canonFile.startsWith(canonDir + File.separator) || !file.isFile()) {
                throw new FileNotFoundException("APK not found");
            }
        } catch (FileNotFoundException e) {
            throw e;
        } catch (Throwable t) {
            throw new FileNotFoundException("Failed to resolve APK");
        }
        return file;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return MIME_APK;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = resolveFile(uri);
        } catch (FileNotFoundException e) {
            return new MatrixCursor(new String[0]);
        }
        String[] cols = (projection != null && projection.length > 0)
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        String[] outCols = new String[cols.length];
        Object[] outVals = new Object[cols.length];
        int n = 0;
        for (String col : cols) {
            if (OpenableColumns.DISPLAY_NAME.equals(col)) {
                outCols[n] = OpenableColumns.DISPLAY_NAME;
                outVals[n++] = file.getName();
            } else if (OpenableColumns.SIZE.equals(col)) {
                outCols[n] = OpenableColumns.SIZE;
                outVals[n++] = file.length();
            }
        }
        String[] finalCols = new String[n];
        Object[] finalVals = new Object[n];
        System.arraycopy(outCols, 0, finalCols, 0, n);
        System.arraycopy(outVals, 0, finalVals, 0, n);
        MatrixCursor cursor = new MatrixCursor(finalCols, 1);
        cursor.addRow(finalVals);
        return cursor;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !"r".equals(mode)) {
            throw new SecurityException("Read-only provider");
        }
        return ParcelFileDescriptor.open(resolveFile(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read-only"); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("Read-only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("Read-only"); }
}
