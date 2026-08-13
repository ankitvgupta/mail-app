import { expect, test } from "@playwright/test";

import { resolveOpencodePlatformBinary } from "../../src/main/agents/providers/opencode/opencode-agent-provider";

test.describe("resolveOpencodePlatformBinary", () => {
  test("finds the unpacked Darwin ARM64 executable from its platform package", () => {
    const packagedPackageJson =
      "/Applications/Exo.app/Contents/Resources/app.asar/node_modules/opencode-darwin-arm64/package.json";
    const packagedExecutable =
      "/Applications/Exo.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode";
    const requestedPackages: string[] = [];

    const resolved = resolveOpencodePlatformBinary({
      platform: "darwin",
      arch: "arm64",
      resourcesPath: "",
      resolvePackageJson: (specifier) => {
        requestedPackages.push(specifier);
        return packagedPackageJson;
      },
      fileExists: (candidate) => candidate === packagedExecutable,
    });

    expect(requestedPackages).toEqual(["opencode-darwin-arm64/package.json"]);
    expect(resolved).toBe(packagedExecutable);
  });

  test("uses the Windows package and executable names", () => {
    const packagedPackageJson =
      "C:\\Program Files\\Exo\\resources\\app.asar\\node_modules\\opencode-windows-x64-baseline\\package.json";
    const packagedExecutable =
      "C:\\Program Files\\Exo\\resources\\app.asar.unpacked\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe";
    const requestedPackages: string[] = [];

    const resolved = resolveOpencodePlatformBinary({
      platform: "win32",
      arch: "x64",
      resourcesPath: "",
      resolvePackageJson: (specifier) => {
        requestedPackages.push(specifier);
        return packagedPackageJson;
      },
      fileExists: (candidate) => candidate === packagedExecutable,
    });

    expect(requestedPackages).toEqual(["opencode-windows-x64-baseline/package.json"]);
    expect(resolved).toBe(packagedExecutable);
  });

  test("resolves packaged workers directly from Electron's resources path", () => {
    const packagedExecutable =
      "/Applications/Exo.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode";

    const resolved = resolveOpencodePlatformBinary({
      platform: "darwin",
      arch: "arm64",
      resourcesPath: "/Applications/Exo.app/Contents/Resources",
      resolvePackageJson: () => {
        throw new Error("packaged resolution must not require Node module lookup");
      },
      fileExists: (candidate) => candidate === packagedExecutable,
    });

    expect(resolved).toBe(packagedExecutable);
  });
});
