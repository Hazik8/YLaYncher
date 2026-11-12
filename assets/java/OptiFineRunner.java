import java.io.File;
import java.lang.reflect.Method;

/**
 * Small headless bridge for the official OptiFine installer.
 *
 * The OptiFine installer normally uses the default Minecraft directory
 * (%APPDATA%/.minecraft). Y LaYncher supports arbitrary game directories, so
 * this helper calls the public installer entry point with an explicit path.
 */
public final class OptiFineRunner {
    private OptiFineRunner() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args[0].trim().isEmpty()) {
            System.err.println("Usage: OptiFineRunner <game-directory>");
            System.exit(2);
        }

        File gameDir = new File(args[0]);
        Class<?> installer = Class.forName("optifine.Installer");
        Method doInstall = installer.getMethod("doInstall", File.class);
        doInstall.invoke(null, gameDir);
    }
}
