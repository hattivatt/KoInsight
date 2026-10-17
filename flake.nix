{
  description = "KoInsight — self-hosted KOReader reading statistics server";

  inputs = {
    # Matches the nixpkgs channel used by the host (nixos-unstable / 26.11pre).
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      lib = nixpkgs.lib;
      forAllSystems = f: lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (pkgs: rec {
        koinsight = pkgs.buildNpmPackage (finalAttrs: {
          pname = "koinsight";
          version = "0.2.4";

          # Explicit filtered source: `./.` would silently follow flake git
          # tracking (untracked files) and would drag in node_modules/dist.
          src = builtins.path {
            name = "koinsight-source";
            path = ./.;
            filter =
              path: _type:
              let
                base = baseNameOf path;
              in
              !(builtins.elem base [
                "node_modules"
                "dist"
                ".git"
                ".turbo"
                "data"
                ".docker-data"
                "test"
                "result"
              ]);
          };

          npmDeps = pkgs.fetchNpmDeps {
            inherit (finalAttrs) src;
            hash = "sha256-0jZ+B3Ufe+eYFPs2+tq0cJLYX56HRy/2v8gjnq7ENUc=";
          };

          # Node 22 is required by the project (`engines.node >= 22`).
          nodejs = pkgs.nodejs_22;

          env = {
            # Force better-sqlite3 to compile from source with node-gyp instead
            # of trying (and failing) to download a prebuilt binary offline.
            npm_config_build_from_source = "true";
            npm_config_update_notifier = "false";
            npm_config_fund = "false";
            npm_config_audit = "false";
            TURBO_TELEMETRY_DISABLED = "1";
          };

          # Skip the root `turbo run build` script: Turbo wants to talk to its
          # remote cache / write to $HOME. Build the workspaces directly in
          # dependency order instead.
          dontNpmBuild = true;
          buildPhase = ''
            runHook preBuild
            npm run --workspace=@koinsight/common build
            npm run --workspace=server build
            npm run --workspace=web build
            runHook postBuild
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            root="$out/libexec/koinsight"
            mkdir -p "$root"

            # Runtime node_modules (includes the compiled better-sqlite3 addon).
            cp -r node_modules "$root/node_modules"
            cp package.json "$root/package.json"

            # Compiled server + static web build + KOReader plugin bundle.
            mkdir -p "$root/apps/server" "$root/apps/web"
            cp -r apps/server/dist "$root/apps/server/dist"
            cp -r apps/web/dist "$root/apps/web/dist"
            cp -r plugins "$root/plugins"

            # `@koinsight/common` is a workspace symlink; after the monorepo
            # layout is flattened the runtime `require('@koinsight/common/...')`
            # cannot rely on workspace resolution. Its package.json now declares
            # `main`/`exports` too, but we still ship a self-contained copy with
            # an explicit exports map as belt-and-braces (Node 22 supports
            # require() of the ES modules it points at).
            rm -f "$root/node_modules/@koinsight/common"
            mkdir -p "$root/node_modules/@koinsight/common"
            cp -r packages/common/dist "$root/node_modules/@koinsight/common/dist"

            # Take the version from the real workspace package.json so the
            # synthetic copy never drifts from the released version.
            common_version="$(node -p "require('./packages/common/package.json').version")"

            cat > "$root/node_modules/@koinsight/common/package.json" <<EOF
            {
              "name": "@koinsight/common",
              "version": "''${common_version}",
              "type": "module",
              "exports": {
                "./types": "./dist/types/index.js",
                "./types/*": "./dist/types/*.js",
                "./utils/*": "./dist/utils/*.js",
                "./*": "./dist/*.js"
              }
            }
            EOF

            # Launcher: DATA_PATH must be writable (the in-store default would
            # resolve into the read-only Nix store).
            mkdir -p "$out/bin"
            makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/koinsight" \
              --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 ]} \
              --set-default NODE_ENV production \
              --run 'if [ -z "''${DATA_PATH-}" ]; then export DATA_PATH="''${XDG_DATA_HOME:-$HOME/.local/share}/koinsight"; fi' \
              --add-flags "$out/libexec/koinsight/apps/server/dist/app.js"

            runHook postInstall
          '';

          meta = {
            description = "Self-hosted KOReader reading statistics server";
            homepage = "https://github.com/GeorgeSG/KoInsight";
            license = lib.licenses.mit;
            mainProgram = "koinsight";
            platforms = lib.platforms.linux;
          };
        });
        default = koinsight;
      });

      apps = forAllSystems (pkgs: rec {
        koinsight = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.koinsight}/bin/koinsight";
          meta.description = "Run the KoInsight statistics server";
        };
        default = koinsight;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.git
          ];
        };
      });
    };
}
