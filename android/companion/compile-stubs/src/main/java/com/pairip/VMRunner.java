package com.pairip;

import java.util.concurrent.Future;

public class VMRunner {
    private static Future<?> job;

    public static Future<?> getJob() {
        return job;
    }

    public static void setJob(Future<?> f) {
        job = f;
    }

    public static Object invoke(String vmId, Object[] args) {
        return null;
    }
}
