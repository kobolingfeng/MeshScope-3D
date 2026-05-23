// 强强 — Ultra-thin Win32 + WebView2 shell
// Single-file C++ shell with full native API surface.
//
// Build:
//   cl /EHsc /O2 /std:c++20 /utf-8 main.cpp
//      /I<webview2_include> /I<json_include>
//      /Fe:app.exe /link /SUBSYSTEM:WINDOWS <WebView2LoaderStatic.lib>
//
// Usage:
//   app.exe                              -> Production (virtual host -> dist/)
//   app.exe --dev http://localhost:3000  -> Dev mode

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <string>
#include <cctype>
#include <cwctype>
#include <cstring>
#include <functional>
#include <unordered_map>
#include <vector>
#include <filesystem>
#include <fstream>
#include <dwmapi.h>
#include <windowsx.h>
#include <winhttp.h>
#include <mutex>
#include <atomic>
#include <algorithm>
#include <set>
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "winhttp.lib")

#include "resource.h"

#include "json.hpp"
using json = nlohmann::json;
using namespace Microsoft::WRL;
namespace fspath = std::filesystem;

// ================================================================
//  String helpers
// ================================================================

static std::string W2U(const wchar_t* w, int len = -1) {
    if (!w || !*w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, len, s.data(), n, nullptr, nullptr);
    if (len == -1 && !s.empty() && s.back() == '\0') s.pop_back();
    return s;
}
static std::string W2U(const std::wstring& w) { return W2U(w.c_str(), (int)w.size()); }

static std::wstring U2W(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
    return w;
}

static std::wstring exe_path();

static std::wstring exe_dir() {
    auto path = exe_path();
    if (path.empty()) return path;
    PathRemoveFileSpecW(path.data());
    path.resize(wcslen(path.c_str()));
    return path;
}

static std::wstring exe_path() {
    std::wstring path(MAX_PATH, L'\0');
    for (;;) {
        DWORD len = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (len == 0) return {};
        if (len < path.size() - 1) {
            path.resize(len);
            return path;
        }
        path.resize(path.size() * 2);
    }
}

static std::wstring normalize_path(const std::wstring& path) {
    try {
        return fspath::weakly_canonical(fspath::path(path)).wstring();
    } catch (...) {
        try { return fspath::absolute(fspath::path(path)).wstring(); }
        catch (...) { return path; }
    }
}

static std::wstring instance_identity_suffix() {
    auto path = normalize_path(exe_path());
    uint64_t hash = 1469598103934665603ull;
    for (wchar_t ch : path) {
        hash ^= static_cast<uint64_t>(towlower(ch));
        hash *= 1099511628211ull;
    }
    wchar_t suffix[32]{};
    swprintf_s(suffix, L"%016llX", static_cast<unsigned long long>(hash));
    return suffix;
}

static std::wstring instance_mutex_name() {
    return std::wstring(L"Local\\MeshScope3D.App.") + instance_identity_suffix();
}

static std::string base64_encode(const std::string& input) {
    static constexpr char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((input.size() + 2) / 3) * 4);

    size_t i = 0;
    while (i + 2 < input.size()) {
        const auto a = static_cast<unsigned char>(input[i++]);
        const auto b = static_cast<unsigned char>(input[i++]);
        const auto c = static_cast<unsigned char>(input[i++]);
        out.push_back(kTable[a >> 2]);
        out.push_back(kTable[((a & 0x03) << 4) | (b >> 4)]);
        out.push_back(kTable[((b & 0x0F) << 2) | (c >> 6)]);
        out.push_back(kTable[c & 0x3F]);
    }

    if (i < input.size()) {
        const auto a = static_cast<unsigned char>(input[i++]);
        out.push_back(kTable[a >> 2]);
        if (i < input.size()) {
            const auto b = static_cast<unsigned char>(input[i]);
            out.push_back(kTable[((a & 0x03) << 4) | (b >> 4)]);
            out.push_back(kTable[(b & 0x0F) << 2]);
            out.push_back('=');
        } else {
            out.push_back(kTable[(a & 0x03) << 4]);
            out.push_back('=');
            out.push_back('=');
        }
    }

    return out;
}

static int base64_value(char ch) {
    if (ch >= 'A' && ch <= 'Z') return ch - 'A';
    if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9') return ch - '0' + 52;
    if (ch == '+') return 62;
    if (ch == '/') return 63;
    return -1;
}

static std::string base64_decode(const std::string& input) {
    std::string out;
    out.reserve((input.size() / 4) * 3);

    int value = 0;
    int bits = -8;
    for (char ch : input) {
        if (ch == '=') break;
        if (std::isspace(static_cast<unsigned char>(ch))) continue;

        int decoded = base64_value(ch);
        if (decoded < 0) throw std::runtime_error("Invalid base64 content");

        value = (value << 6) | decoded;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<char>((value >> bits) & 0xFF));
            bits -= 8;
        }
    }

    return out;
}

static bool has_url_scheme(const std::wstring& value) {
    const auto colon = value.find(L':');
    if (colon == std::wstring::npos || colon < 2) return false;
    if (!iswalpha(value[0])) return false;
    for (size_t i = 1; i < colon; ++i) {
        const auto ch = value[i];
        if (!iswalnum(ch) && ch != L'+' && ch != L'-' && ch != L'.') return false;
    }
    return true;
}

static bool is_valid_protocol_scheme(const std::string& scheme) {
    if (scheme.empty() || !isalpha(static_cast<unsigned char>(scheme[0]))) return false;
    for (char ch : scheme) {
        const auto c = static_cast<unsigned char>(ch);
        if (!isalnum(c) && ch != '+' && ch != '-' && ch != '.') return false;
    }
    auto lower = scheme;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(tolower(c));
    });
    return lower != "http"
        && lower != "https"
        && lower != "file"
        && lower.rfind("ms-", 0) != 0;
}

static std::wstring copydata_payload(const std::vector<std::wstring>& items) {
    json payload = json::array();
    for (const auto& item : items) payload.push_back(W2U(item));
    return U2W(payload.dump());
}

static constexpr DWORD kMaxCopyDataBytes = 2 * 1024 * 1024;

static std::vector<std::wstring> parse_copydata_payload(const COPYDATASTRUCT* data) {
    if (!data || !data->lpData) return {};
    if (data->cbData == 0 || data->cbData > kMaxCopyDataBytes) return {};
    if (data->cbData % sizeof(wchar_t) != 0) return {};

    const auto count = static_cast<size_t>(data->cbData / sizeof(wchar_t));
    std::wstring payload(reinterpret_cast<const wchar_t*>(data->lpData), count);
    if (!payload.empty() && payload.back() == L'\0') payload.pop_back();

    try {
        auto parsed = json::parse(W2U(payload));
        if (!parsed.is_array()) return {};
        std::vector<std::wstring> items;
        for (const auto& item : parsed) {
            if (item.is_string()) items.push_back(U2W(item.get<std::string>()));
        }
        return items;
    } catch (...) {
        return {};
    }
}

static void send_copydata_payload(HWND target, ULONG_PTR kind, const std::vector<std::wstring>& items) {
    if (!target || items.empty()) return;

    auto sendBatch = [&](const std::vector<std::wstring>& batch) {
        if (batch.empty()) return;
        auto payload = copydata_payload(batch);
        const auto bytes = (payload.size() + 1) * sizeof(wchar_t);
        if (bytes > kMaxCopyDataBytes) return;

        COPYDATASTRUCT data{};
        data.dwData = kind;
        data.cbData = static_cast<DWORD>(bytes);
        data.lpData = payload.data();
        DWORD_PTR ignored = 0;
        SendMessageTimeoutW(
            target,
            WM_COPYDATA,
            0,
            reinterpret_cast<LPARAM>(&data),
            SMTO_ABORTIFHUNG,
            3000,
            &ignored
        );
    };

    std::vector<std::wstring> batch;
    for (const auto& item : items) {
        auto next = batch;
        next.push_back(item);
        const auto bytes = (copydata_payload(next).size() + 1) * sizeof(wchar_t);
        if (bytes > kMaxCopyDataBytes) {
            sendBatch(batch);
            batch.clear();
            const auto singleBytes = (copydata_payload({item}).size() + 1) * sizeof(wchar_t);
            if (singleBytes <= kMaxCopyDataBytes) batch.push_back(item);
            continue;
        }
        batch.push_back(item);
    }
    sendBatch(batch);
}

static void restore_and_focus_window(HWND target) {
    if (!target) return;
    ShowWindow(target, IsIconic(target) ? SW_RESTORE : SW_SHOW);
    if (!SetForegroundWindow(target)) {
        FLASHWINFO info{sizeof(info)};
        info.hwnd = target;
        info.dwFlags = FLASHW_TRAY | FLASHW_TIMERNOFG;
        info.uCount = 3;
        FlashWindowEx(&info);
    }
}

// ================================================================
//  Global state
// ================================================================

static HWND                              g_hwnd;
static ComPtr<ICoreWebView2Environment>  g_env;
static ComPtr<ICoreWebView2Controller>   g_ctrl;
static ComPtr<ICoreWebView2>             g_view;
static std::wstring                      g_devUrl;
static bool                              g_webviewReady = false;

// Config
static json g_cfg;
static bool g_frameless    = false;
static bool g_resizable    = true;
static int  g_effectType   = 0; // 0=none, 2=mica, 3=acrylic, 4=micaAlt
static std::unordered_map<std::string, bool> g_permissions; // cmd -> allowed
static std::unordered_map<std::string, std::wstring> g_localFileTokens;
static std::mutex g_localFileTokensMutex;
static std::atomic<uint64_t> g_localFileSeq{0};

// Tray
#define WM_TRAYICON (WM_USER + 1)
static NOTIFYICONDATAW g_nid = {};
static bool            g_trayActive = false;

// File watchers
struct FileWatcher {
    HANDLE hDir;
    HANDLE hThread;
    std::wstring path;
    int id;
    std::atomic<bool> active;
};
static std::unordered_map<int, FileWatcher*> g_watchers;
static int g_nextWatchId = 1;

#define WM_FILE_CHANGED (WM_USER + 2)

// Child windows
struct ChildWindow {
    int id;
    HWND hwnd;
    ComPtr<ICoreWebView2Controller> ctrl;
    ComPtr<ICoreWebView2> view;
};
static std::unordered_map<int, ChildWindow*> g_children;
static int g_nextChildId = 1;

// Splash window
static HWND g_splash = nullptr;

// Logging
static std::wstring g_logFile;
static std::mutex   g_logMtx;

// Background brush for frameless border area
static HBRUSH   g_bgBrush = nullptr;
static COLORREF g_bgClr   = 0;
static std::vector<std::wstring> g_pendingLaunchFiles;
static std::vector<std::wstring> g_pendingLaunchUrls;
static bool g_frontendReady = false;
static constexpr ULONG_PTR kOpenFilesCopyData = 0x51514433;
static constexpr ULONG_PTR kOpenUrlsCopyData = 0x51514434;
static constexpr const wchar_t* kAppUserModelId = L"MeshScope3D.App";
static std::wstring g_windowClassName = L"MeshScope3D.Window";

// Apply DWM visual attributes for frameless window (border, caption, backdrop).
// Called at creation and by window.setBackgroundColor. Not called on focus
// change — Wails doesn't do it either, and with WebView2 filling the full
// client area the 1px DWM border is barely perceptible anyway.
static void applyFramelessDwmAttrs();

// Embedded assets (single-exe mode) — zero-copy: entries point directly into PE section
#ifdef SINGLE_EXE
struct PakEntry { std::string path; const char* data; uint32_t size; };
static std::vector<PakEntry> g_pakEntries;
#endif


static std::wstring g_appDataDir;
static std::wstring app_data_dir() {
    if (!g_appDataDir.empty()) return g_appDataDir;
    PWSTR p = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p))) {
        auto title = g_cfg.value("/window/title"_json_pointer, std::string{"QQ"});
        g_appDataDir = std::wstring(p) + L"\\" + U2W(title);
        CoTaskMemFree(p);
    } else {
        g_appDataDir = exe_dir() + L"\\data";
    }
    fspath::create_directories(g_appDataDir);
    return g_appDataDir;
}

static std::string make_local_file_token() {
    const auto seq = ++g_localFileSeq;
    return std::to_string(GetCurrentProcessId())
        + "-" + std::to_string(GetTickCount64())
        + "-" + std::to_string(seq);
}

static std::string decode_url_component(const std::string& value) {
    std::string decoded;
    decoded.reserve(value.size());
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '%' && i + 2 < value.size()) {
            auto hex = [](char ch) -> int {
                if (ch >= '0' && ch <= '9') return ch - '0';
                if (ch >= 'a' && ch <= 'f') return 10 + ch - 'a';
                if (ch >= 'A' && ch <= 'F') return 10 + ch - 'A';
                return -1;
            };
            const int hi = hex(value[i + 1]);
            const int lo = hex(value[i + 2]);
            if (hi >= 0 && lo >= 0) {
                decoded.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        decoded.push_back(value[i]);
    }
    return decoded;
}

static bool extract_local_file_token_from_path(const std::string& path, std::string& token) {
    static constexpr const char* prefix = "__meshscope_file__/";
    static constexpr size_t prefixLen = 19;
    if (path.rfind(prefix, 0) != 0) return false;
    token = path.substr(prefixLen);
    const auto slash = token.find('/');
    if (slash != std::string::npos) token = token.substr(0, slash);
    token = decode_url_component(token);
    return !token.empty();
}

static bool extract_local_file_token_from_uri(const std::wstring& uri, std::string& token) {
    const std::string text = W2U(uri);
    static constexpr const char* marker = "/__meshscope_file__/";
    static constexpr size_t markerLen = 20;
    const auto markerPos = text.find(marker);
    if (markerPos == std::string::npos) return false;
    const auto start = markerPos + markerLen;
    auto end = text.find_first_of("/?#", start);
    if (end == std::string::npos) end = text.size();
    token = decode_url_component(text.substr(start, end - start));
    return !token.empty();
}

static std::wstring local_file_mime_type(const std::wstring& path) {
    auto ext = fspath::path(path).extension().wstring();
    std::transform(ext.begin(), ext.end(), ext.begin(), [](wchar_t ch) {
        return static_cast<wchar_t>(std::towlower(ch));
    });
    if (ext == L".glb") return L"model/gltf-binary";
    if (ext == L".gltf") return L"model/gltf+json";
    if (ext == L".json") return L"application/json";
    if (ext == L".png") return L"image/png";
    if (ext == L".jpg" || ext == L".jpeg") return L"image/jpeg";
    if (ext == L".webp") return L"image/webp";
    if (ext == L".gif") return L"image/gif";
    return L"application/octet-stream";
}

static HRESULT respond_text_resource(
    ICoreWebView2WebResourceRequestedEventArgs* args,
    int status,
    const wchar_t* reason,
    const char* body
) {
    const auto len = static_cast<UINT>(strlen(body));
    ComPtr<IStream> stream;
    stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body), len));
    if (!stream) return S_OK;

    ComPtr<ICoreWebView2WebResourceResponse> response;
    g_env->CreateWebResourceResponse(
        stream.Get(),
        status,
        reason,
        L"Content-Type: text/plain; charset=utf-8\r\nAccess-Control-Allow-Origin: *",
        &response);
    args->put_Response(response.Get());
    return S_OK;
}

static HRESULT respond_local_file_resource(
    ICoreWebView2WebResourceRequestedEventArgs* args,
    const std::string& token
) {
    std::wstring path;
    {
        std::lock_guard<std::mutex> lock(g_localFileTokensMutex);
        auto it = g_localFileTokens.find(token);
        if (it == g_localFileTokens.end()) {
            return respond_text_resource(args, 404, L"Not Found", "Unknown file token");
        }
        path = it->second;
    }

    if (!fspath::exists(path) || !fspath::is_regular_file(path)) {
        return respond_text_resource(args, 404, L"Not Found", "File not found");
    }

    ComPtr<IStream> stream;
    const HRESULT hr = SHCreateStreamOnFileEx(
        path.c_str(),
        STGM_READ | STGM_SHARE_DENY_NONE,
        FILE_ATTRIBUTE_NORMAL,
        FALSE,
        nullptr,
        stream.GetAddressOf());
    if (FAILED(hr) || !stream) {
        return respond_text_resource(args, 500, L"Internal Server Error", "Cannot open file");
    }

    const std::wstring headers = L"Content-Type: " + local_file_mime_type(path)
        + L"\r\nAccess-Control-Allow-Origin: *"
        + L"\r\nCache-Control: no-store";

    ComPtr<ICoreWebView2WebResourceResponse> response;
    g_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &response);
    args->put_Response(response.Get());
    return S_OK;
}

static void write_u32(std::ofstream& out, uint32_t value) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

static void add_json_index(const json& array, int index, std::set<int>& target) {
    if (index >= 0 && index < static_cast<int>(array.size())) target.insert(index);
}

static void collect_accessor_refs_recursive(
    const json& node,
    const json& accessors,
    const json& bufferViews,
    std::set<int>& usedAccessors,
    std::set<int>& usedBufferViews
) {
    if (node.is_object()) {
        for (auto it = node.begin(); it != node.end(); ++it) {
            const std::string key = it.key();
            if (key == "accessors" || key == "bufferViews" || key == "buffers" || key == "animations") {
                continue;
            }
            if (key == "accessor" && it.value().is_number_integer()) {
                add_json_index(accessors, it.value().get<int>(), usedAccessors);
                continue;
            }
            if (key == "bufferView" && it.value().is_number_integer()) {
                add_json_index(bufferViews, it.value().get<int>(), usedBufferViews);
                continue;
            }
            collect_accessor_refs_recursive(it.value(), accessors, bufferViews, usedAccessors, usedBufferViews);
        }
        return;
    }
    if (node.is_array()) {
        for (const auto& child : node) {
            collect_accessor_refs_recursive(child, accessors, bufferViews, usedAccessors, usedBufferViews);
        }
    }
}

static void collect_mesh_accessor_refs(const json& doc, std::set<int>& usedAccessors, std::set<int>& usedBufferViews) {
    const json emptyArray = json::array();
    const auto& accessors = doc.contains("accessors") && doc["accessors"].is_array()
        ? doc["accessors"]
        : emptyArray;
    const auto& bufferViews = doc.contains("bufferViews") && doc["bufferViews"].is_array()
        ? doc["bufferViews"]
        : emptyArray;

    if (doc.contains("meshes") && doc["meshes"].is_array()) {
        for (const auto& mesh : doc["meshes"]) {
            if (!mesh.contains("primitives") || !mesh["primitives"].is_array()) continue;
            for (const auto& primitive : mesh["primitives"]) {
                if (primitive.contains("indices") && primitive["indices"].is_number_integer()) {
                    add_json_index(accessors, primitive["indices"].get<int>(), usedAccessors);
                }
                if (primitive.contains("attributes") && primitive["attributes"].is_object()) {
                    for (const auto& item : primitive["attributes"].items()) {
                        if (item.value().is_number_integer()) add_json_index(accessors, item.value().get<int>(), usedAccessors);
                    }
                }
                if (primitive.contains("targets") && primitive["targets"].is_array()) {
                    for (const auto& target : primitive["targets"]) {
                        if (!target.is_object()) continue;
                        for (const auto& item : target.items()) {
                            if (item.value().is_number_integer()) add_json_index(accessors, item.value().get<int>(), usedAccessors);
                        }
                    }
                }
                if (primitive.contains("extensions")) {
                    collect_accessor_refs_recursive(
                        primitive["extensions"],
                        accessors,
                        bufferViews,
                        usedAccessors,
                        usedBufferViews);
                }
            }
        }
    }

    if (doc.contains("skins") && doc["skins"].is_array()) {
        for (const auto& skin : doc["skins"]) {
            if (skin.contains("inverseBindMatrices") && skin["inverseBindMatrices"].is_number_integer()) {
                add_json_index(accessors, skin["inverseBindMatrices"].get<int>(), usedAccessors);
            }
        }
    }

    if (doc.contains("images") && doc["images"].is_array()) {
        for (const auto& image : doc["images"]) {
            if (image.contains("bufferView") && image["bufferView"].is_number_integer()) {
                add_json_index(bufferViews, image["bufferView"].get<int>(), usedBufferViews);
            }
        }
    }

    collect_accessor_refs_recursive(doc, accessors, bufferViews, usedAccessors, usedBufferViews);

    for (const int accessorIndex : usedAccessors) {
        const auto& accessor = accessors[accessorIndex];
        if (accessor.contains("bufferView") && accessor["bufferView"].is_number_integer()) {
            add_json_index(bufferViews, accessor["bufferView"].get<int>(), usedBufferViews);
        }
        if (accessor.contains("sparse") && accessor["sparse"].is_object()) {
            const auto& sparse = accessor["sparse"];
            if (sparse.contains("indices") && sparse["indices"].contains("bufferView")) {
                add_json_index(bufferViews, sparse["indices"]["bufferView"].get<int>(), usedBufferViews);
            }
            if (sparse.contains("values") && sparse["values"].contains("bufferView")) {
                add_json_index(bufferViews, sparse["values"]["bufferView"].get<int>(), usedBufferViews);
            }
        }
    }
}

static json collect_glb_animation_metas(const json& doc) {
    json result = json::array();
    if (!doc.contains("animations") || !doc["animations"].is_array()) return result;

    const json emptyArray = json::array();
    const auto& accessors = doc.contains("accessors") && doc["accessors"].is_array()
        ? doc["accessors"]
        : emptyArray;

    int index = 0;
    for (const auto& animation : doc["animations"]) {
        double duration = 0.0;
        const auto name = animation.value("name", std::string{});
        const int tracks = animation.contains("channels") && animation["channels"].is_array()
            ? static_cast<int>(animation["channels"].size())
            : 0;

        if (animation.contains("samplers") && animation["samplers"].is_array()) {
            for (const auto& sampler : animation["samplers"]) {
                if (!sampler.contains("input") || !sampler["input"].is_number_integer()) continue;
                const int accessorIndex = sampler["input"].get<int>();
                if (accessorIndex < 0 || accessorIndex >= static_cast<int>(accessors.size())) continue;
                const auto& accessor = accessors[accessorIndex];
                if (!accessor.contains("max") || !accessor["max"].is_array() || accessor["max"].empty()) continue;
                if (accessor["max"][0].is_number()) {
                    duration = std::max(duration, accessor["max"][0].get<double>());
                }
            }
        }

        result.push_back({
            {"index", index},
            {"name", name.empty() ? ("Animation " + std::to_string(index + 1)) : name},
            {"duration", duration},
            {"tracks", tracks}
        });
        ++index;
    }
    return result;
}

static void collect_animation_accessor_refs(
    const json& animation,
    const json& accessors,
    const json& bufferViews,
    std::set<int>& usedAccessors,
    std::set<int>& usedBufferViews
) {
    if (animation.contains("samplers") && animation["samplers"].is_array()) {
        for (const auto& sampler : animation["samplers"]) {
            if (sampler.contains("input") && sampler["input"].is_number_integer()) {
                add_json_index(accessors, sampler["input"].get<int>(), usedAccessors);
            }
            if (sampler.contains("output") && sampler["output"].is_number_integer()) {
                add_json_index(accessors, sampler["output"].get<int>(), usedAccessors);
            }
        }
    }

    if (animation.contains("extensions")) {
        collect_accessor_refs_recursive(animation["extensions"], accessors, bufferViews, usedAccessors, usedBufferViews);
    }
    if (animation.contains("extras")) {
        collect_accessor_refs_recursive(animation["extras"], accessors, bufferViews, usedAccessors, usedBufferViews);
    }
}

static void collect_buffer_views_for_accessors(
    const json& accessors,
    const json& bufferViews,
    const std::set<int>& usedAccessors,
    std::set<int>& usedBufferViews
) {
    for (const int accessorIndex : usedAccessors) {
        if (accessorIndex < 0 || accessorIndex >= static_cast<int>(accessors.size())) continue;
        const auto& accessor = accessors[accessorIndex];
        if (accessor.contains("bufferView") && accessor["bufferView"].is_number_integer()) {
            add_json_index(bufferViews, accessor["bufferView"].get<int>(), usedBufferViews);
        }
        if (accessor.contains("sparse") && accessor["sparse"].is_object()) {
            const auto& sparse = accessor["sparse"];
            if (sparse.contains("indices") && sparse["indices"].contains("bufferView")) {
                add_json_index(bufferViews, sparse["indices"]["bufferView"].get<int>(), usedBufferViews);
            }
            if (sparse.contains("values") && sparse["values"].contains("bufferView")) {
                add_json_index(bufferViews, sparse["values"]["bufferView"].get<int>(), usedBufferViews);
            }
        }
    }
}

static int mapped_index(const std::vector<int>& map, int index) {
    return index >= 0 && index < static_cast<int>(map.size()) ? map[index] : -1;
}

static void remap_direct_refs_recursive(json& node, const std::vector<int>& accessorMap, const std::vector<int>& bufferViewMap) {
    if (node.is_object()) {
        for (auto it = node.begin(); it != node.end(); ++it) {
            const std::string key = it.key();
            if (key == "accessors" || key == "bufferViews" || key == "buffers" || key == "animations") {
                continue;
            }
            if (key == "accessor" && it.value().is_number_integer()) {
                const int mapped = mapped_index(accessorMap, it.value().get<int>());
                if (mapped >= 0) it.value() = mapped;
                continue;
            }
            if (key == "bufferView" && it.value().is_number_integer()) {
                const int mapped = mapped_index(bufferViewMap, it.value().get<int>());
                if (mapped >= 0) it.value() = mapped;
                continue;
            }
            remap_direct_refs_recursive(it.value(), accessorMap, bufferViewMap);
        }
        return;
    }
    if (node.is_array()) {
        for (auto& child : node) remap_direct_refs_recursive(child, accessorMap, bufferViewMap);
    }
}

static void remap_mesh_accessor_refs(json& doc, const std::vector<int>& accessorMap) {
    if (doc.contains("meshes") && doc["meshes"].is_array()) {
        for (auto& mesh : doc["meshes"]) {
            if (!mesh.contains("primitives") || !mesh["primitives"].is_array()) continue;
            for (auto& primitive : mesh["primitives"]) {
                if (primitive.contains("indices") && primitive["indices"].is_number_integer()) {
                    const int mapped = mapped_index(accessorMap, primitive["indices"].get<int>());
                    if (mapped >= 0) primitive["indices"] = mapped;
                }
                if (primitive.contains("attributes") && primitive["attributes"].is_object()) {
                    for (auto& item : primitive["attributes"].items()) {
                        if (!item.value().is_number_integer()) continue;
                        const int mapped = mapped_index(accessorMap, item.value().get<int>());
                        if (mapped >= 0) item.value() = mapped;
                    }
                }
                if (primitive.contains("targets") && primitive["targets"].is_array()) {
                    for (auto& target : primitive["targets"]) {
                        if (!target.is_object()) continue;
                        for (auto& item : target.items()) {
                            if (!item.value().is_number_integer()) continue;
                            const int mapped = mapped_index(accessorMap, item.value().get<int>());
                            if (mapped >= 0) item.value() = mapped;
                        }
                    }
                }
            }
        }
    }
    if (doc.contains("skins") && doc["skins"].is_array()) {
        for (auto& skin : doc["skins"]) {
            if (!skin.contains("inverseBindMatrices") || !skin["inverseBindMatrices"].is_number_integer()) continue;
            const int mapped = mapped_index(accessorMap, skin["inverseBindMatrices"].get<int>());
            if (mapped >= 0) skin["inverseBindMatrices"] = mapped;
        }
    }
}

static void remap_animation_accessor_refs(
    json& animation,
    const std::vector<int>& accessorMap,
    const std::vector<int>& bufferViewMap
) {
    if (animation.contains("samplers") && animation["samplers"].is_array()) {
        for (auto& sampler : animation["samplers"]) {
            if (sampler.contains("input") && sampler["input"].is_number_integer()) {
                const int mapped = mapped_index(accessorMap, sampler["input"].get<int>());
                if (mapped >= 0) sampler["input"] = mapped;
            }
            if (sampler.contains("output") && sampler["output"].is_number_integer()) {
                const int mapped = mapped_index(accessorMap, sampler["output"].get<int>());
                if (mapped >= 0) sampler["output"] = mapped;
            }
        }
    }
    if (animation.contains("extensions")) {
        remap_direct_refs_recursive(animation["extensions"], accessorMap, bufferViewMap);
    }
    if (animation.contains("extras")) {
        remap_direct_refs_recursive(animation["extras"], accessorMap, bufferViewMap);
    }
}

static void copy_stream_range(std::ifstream& in, std::ofstream& out, uint64_t offset, uint64_t length) {
    constexpr size_t kChunk = 1024 * 1024;
    std::vector<char> buffer(kChunk);
    in.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
    uint64_t remaining = length;
    while (remaining > 0) {
        const size_t readSize = static_cast<size_t>(std::min<uint64_t>(remaining, buffer.size()));
        in.read(buffer.data(), static_cast<std::streamsize>(readSize));
        const auto got = static_cast<size_t>(in.gcount());
        if (got == 0) throw std::runtime_error("Unexpected EOF while copying GLB bufferView");
        out.write(buffer.data(), static_cast<std::streamsize>(got));
        remaining -= got;
    }
}

static json create_glb_preview_file(
    const std::wstring& sourcePath,
    const std::string& protocol,
    uint64_t minBytes,
    int animationIndex = -1
) {
    std::ifstream in(sourcePath, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot open GLB");

    uint32_t header[3] = {};
    in.read(reinterpret_cast<char*>(header), sizeof(header));
    if (!in || header[0] != 0x46546C67 || header[1] != 2) {
        throw std::runtime_error("Not a GLB v2 file");
    }
    const uint64_t totalLength = header[2];
    if (minBytes > 0 && totalLength < minBytes) {
        return {{"used", false}, {"reason", "below-threshold"}, {"originalBytes", totalLength}};
    }

    uint64_t cursor = 12;
    uint64_t binOffset = 0;
    uint32_t binLength = 0;
    std::string jsonText;

    while (cursor + 8 <= totalLength) {
        uint32_t chunkLength = 0;
        uint32_t chunkType = 0;
        in.seekg(static_cast<std::streamoff>(cursor), std::ios::beg);
        in.read(reinterpret_cast<char*>(&chunkLength), 4);
        in.read(reinterpret_cast<char*>(&chunkType), 4);
        cursor += 8;
        if (!in || cursor + chunkLength > totalLength) break;

        if (chunkType == 0x4E4F534A) {
            jsonText.resize(chunkLength);
            in.read(jsonText.data(), chunkLength);
        } else if (chunkType == 0x004E4942) {
            binOffset = cursor;
            binLength = chunkLength;
        }
        cursor += chunkLength;
    }

    if (jsonText.empty() || binOffset == 0 || binLength == 0) {
        throw std::runtime_error("GLB is missing JSON or BIN chunk");
    }

    json doc = json::parse(jsonText);
    const json animationMetas = collect_glb_animation_metas(doc);
    const int animationCount = doc.contains("animations") && doc["animations"].is_array()
        ? static_cast<int>(doc["animations"].size())
        : 0;
    if (animationCount <= 0) {
        return {{"used", false}, {"reason", "no-animations"}, {"originalBytes", totalLength}};
    }
    if (animationIndex >= animationCount) {
        throw std::runtime_error("Animation index out of range");
    }

    if (animationIndex >= 0) {
        doc["animations"] = json::array({doc["animations"][animationIndex]});
    } else {
        doc.erase("animations");
    }

    const json emptyArray = json::array();
    const auto& oldAccessors = doc.contains("accessors") && doc["accessors"].is_array()
        ? doc["accessors"]
        : emptyArray;
    const auto& oldBufferViews = doc.contains("bufferViews") && doc["bufferViews"].is_array()
        ? doc["bufferViews"]
        : emptyArray;

    std::set<int> usedAccessors;
    std::set<int> usedBufferViews;
    collect_mesh_accessor_refs(doc, usedAccessors, usedBufferViews);
    if (animationIndex >= 0 && doc.contains("animations") && doc["animations"].is_array() && !doc["animations"].empty()) {
        collect_animation_accessor_refs(doc["animations"][0], oldAccessors, oldBufferViews, usedAccessors, usedBufferViews);
        collect_buffer_views_for_accessors(oldAccessors, oldBufferViews, usedAccessors, usedBufferViews);
    }
    if (usedBufferViews.empty()) {
        return {{"used", false}, {"reason", "no-bufferViews"}, {"originalBytes", totalLength}};
    }

    const auto token = make_local_file_token();
    const std::wstring cacheDir = app_data_dir() + L"\\preview-cache";
    fspath::create_directories(cacheDir);
    const std::wstring previewPath = cacheDir + L"\\" + U2W(token) + L".glb";
    const std::wstring tempBinPath = cacheDir + L"\\" + U2W(token) + L".bin";

    std::vector<int> accessorMap(oldAccessors.size(), -1);
    std::vector<int> bufferViewMap(oldBufferViews.size(), -1);
    json newAccessors = json::array();
    json newBufferViews = json::array();

    for (const int accessorIndex : usedAccessors) {
        accessorMap[accessorIndex] = static_cast<int>(newAccessors.size());
        newAccessors.push_back(oldAccessors[accessorIndex]);
    }

    std::ofstream tempBin(tempBinPath, std::ios::binary);
    if (!tempBin) throw std::runtime_error("Cannot create preview BIN");

    uint64_t compactBinLength = 0;
    for (const int bufferViewIndex : usedBufferViews) {
        if (bufferViewIndex < 0 || bufferViewIndex >= static_cast<int>(oldBufferViews.size())) continue;
        auto view = oldBufferViews[bufferViewIndex];
        const uint64_t byteOffset = view.value("byteOffset", 0);
        const uint64_t byteLength = view.value("byteLength", 0);
        if (byteOffset + byteLength > binLength) {
            throw std::runtime_error("Invalid GLB bufferView range");
        }
        const uint64_t padding = (4 - (compactBinLength % 4)) % 4;
        for (uint64_t i = 0; i < padding; ++i) tempBin.put('\0');
        compactBinLength += padding;

        bufferViewMap[bufferViewIndex] = static_cast<int>(newBufferViews.size());
        view["buffer"] = 0;
        view["byteOffset"] = compactBinLength;
        newBufferViews.push_back(view);
        copy_stream_range(in, tempBin, binOffset + byteOffset, byteLength);
        compactBinLength += byteLength;
    }
    const uint64_t finalBinPadding = (4 - (compactBinLength % 4)) % 4;
    for (uint64_t i = 0; i < finalBinPadding; ++i) tempBin.put('\0');
    compactBinLength += finalBinPadding;
    tempBin.close();

    for (auto& accessor : newAccessors) {
        if (accessor.contains("bufferView") && accessor["bufferView"].is_number_integer()) {
            const int mapped = mapped_index(bufferViewMap, accessor["bufferView"].get<int>());
            if (mapped >= 0) accessor["bufferView"] = mapped;
        }
        if (accessor.contains("sparse") && accessor["sparse"].is_object()) {
            auto& sparse = accessor["sparse"];
            if (sparse.contains("indices") && sparse["indices"].contains("bufferView")) {
                const int mapped = mapped_index(bufferViewMap, sparse["indices"]["bufferView"].get<int>());
                if (mapped >= 0) sparse["indices"]["bufferView"] = mapped;
            }
            if (sparse.contains("values") && sparse["values"].contains("bufferView")) {
                const int mapped = mapped_index(bufferViewMap, sparse["values"]["bufferView"].get<int>());
                if (mapped >= 0) sparse["values"]["bufferView"] = mapped;
            }
        }
    }

    remap_direct_refs_recursive(doc, accessorMap, bufferViewMap);
    remap_mesh_accessor_refs(doc, accessorMap);
    if (animationIndex >= 0 && doc.contains("animations") && doc["animations"].is_array() && !doc["animations"].empty()) {
        remap_animation_accessor_refs(doc["animations"][0], accessorMap, bufferViewMap);
    }
    doc["accessors"] = newAccessors;
    doc["bufferViews"] = newBufferViews;
    doc["buffers"] = json::array({{{"byteLength", compactBinLength}}});

    std::string compactJson = doc.dump();
    const uint32_t jsonPadding = static_cast<uint32_t>((4 - (compactJson.size() % 4)) % 4);
    compactJson.append(jsonPadding, ' ');

    const uint64_t previewLength = 12 + 8 + compactJson.size() + 8 + compactBinLength;
    if (previewLength > UINT32_MAX || compactJson.size() > UINT32_MAX || compactBinLength > UINT32_MAX) {
        throw std::runtime_error("Preview GLB is too large");
    }

    std::ofstream out(previewPath, std::ios::binary);
    if (!out) throw std::runtime_error("Cannot create preview GLB");
    write_u32(out, 0x46546C67);
    write_u32(out, 2);
    write_u32(out, static_cast<uint32_t>(previewLength));
    write_u32(out, static_cast<uint32_t>(compactJson.size()));
    write_u32(out, 0x4E4F534A);
    out.write(compactJson.data(), static_cast<std::streamsize>(compactJson.size()));
    write_u32(out, static_cast<uint32_t>(compactBinLength));
    write_u32(out, 0x004E4942);

    std::ifstream binIn(tempBinPath, std::ios::binary);
    copy_stream_range(binIn, out, 0, compactBinLength);
    out.close();
    binIn.close();
    DeleteFileW(tempBinPath.c_str());

    {
        std::lock_guard<std::mutex> lock(g_localFileTokensMutex);
        g_localFileTokens[token] = previewPath;
    }

    const auto urlProtocol = protocol == "https:" ? std::string{"https"} : std::string{"http"};
    return {
        {"used", true},
        {"url", urlProtocol + "://app.localhost/__meshscope_file__/" + token},
        {"path", W2U(previewPath)},
        {"originalBytes", totalLength},
        {"previewBytes", previewLength},
        {"animationIndex", animationIndex},
        {"animationsRemoved", animationIndex >= 0 ? 0 : animationCount},
        {"animations", animationMetas},
        {"accessorsKept", newAccessors.size()},
        {"bufferViewsKept", newBufferViews.size()}
    };
}

static void register_local_file_resource_handler() {
    if (!g_view) return;
    g_view->AddWebResourceRequestedFilter(
        L"http://app.localhost/__meshscope_file__/*",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_view->AddWebResourceRequestedFilter(
        L"https://app.localhost/__meshscope_file__/*",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_view->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
            ComPtr<ICoreWebView2WebResourceRequest> request;
            args->get_Request(&request);
            LPWSTR uri;
            request->get_Uri(&uri);
            std::wstring wUri(uri);
            CoTaskMemFree(uri);

            std::string token;
            if (!extract_local_file_token_from_uri(wUri, token)) return S_OK;
            return respond_local_file_resource(args, token);
        }).Get(), nullptr);
}

// ================================================================
//  Embedded resource loader (single-exe mode)
// ================================================================

#ifdef SINGLE_EXE
// Load a small resource as std::string (used for config only)
static std::string loadResourceString(int id) {
    HRSRC hRes = FindResourceW(nullptr, MAKEINTRESOURCE(id), RT_RCDATA);
    if (!hRes) return {};
    HGLOBAL hData = LoadResource(nullptr, hRes);
    if (!hData) return {};
    DWORD sz = SizeofResource(nullptr, hRes);
    auto* ptr = (const char*)LockResource(hData);
    return std::string(ptr, sz);
}

// Zero-copy PAK loader: entries point directly into PE memory-mapped section
static void loadPak() {
    HRSRC hRes = FindResourceW(nullptr, MAKEINTRESOURCE(IDR_HTML), RT_RCDATA);
    if (!hRes) return;
    HGLOBAL hData = LoadResource(nullptr, hRes);
    if (!hData) return;
    DWORD totalSize = SizeofResource(nullptr, hRes);
    const char* base = (const char*)LockResource(hData);
    if (!base || totalSize < 4 || base[0] != 'Q' || base[1] != 'Q') return;
    const char* end = base + totalSize;
    const char* p = base + 2;
    uint16_t count; memcpy(&count, p, 2); p += 2;
    for (uint16_t i = 0; i < count && p < end; i++) {
        if (p + 2 > end) break;
        uint16_t pathLen; memcpy(&pathLen, p, 2); p += 2;
        if (p + pathLen > end) break;
        std::string path(p, pathLen); p += pathLen;
        if (p + 4 > end) break;
        uint32_t dataLen; memcpy(&dataLen, p, 4); p += 4;
        if (p + dataLen > end) break;
        g_pakEntries.push_back({path, p, dataLen});
        p += dataLen;
    }
}

static const PakEntry* findPakEntry(const std::string& path) {
    for (auto& e : g_pakEntries)
        if (e.path == path) return &e;
    return nullptr;
}

static int hex_value(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return 10 + ch - 'a';
    if (ch >= 'A' && ch <= 'F') return 10 + ch - 'A';
    return -1;
}

static std::string percent_decode_path(const std::string& path) {
    std::string decoded;
    decoded.reserve(path.size());
    for (size_t i = 0; i < path.size(); ++i) {
        if (path[i] == '%' && i + 2 < path.size()) {
            const int hi = hex_value(path[i + 1]);
            const int lo = hex_value(path[i + 2]);
            if (hi >= 0 && lo >= 0) {
                decoded.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        decoded.push_back(path[i]);
    }
    return decoded;
}

static bool is_safe_pak_path(const std::string& path) {
    if (path.empty() || path[0] == '/' || path[0] == '\\') return false;
    if (path.find('\\') != std::string::npos) return false;
    if (path.find('\0') != std::string::npos) return false;
    if (path == "." || path == "..") return false;
    if (path.find("/../") != std::string::npos) return false;
    if (path.rfind("../", 0) == 0) return false;
    if (path.size() >= 3 && path.compare(path.size() - 3, 3, "/..") == 0) return false;
    return true;
}

static std::wstring guessMimeType(const std::string& path) {
    auto ext = path.substr(path.rfind('.') + 1);
    if (ext == "html" || ext == "htm") return L"text/html";
    if (ext == "js" || ext == "mjs")   return L"application/javascript";
    if (ext == "css")                  return L"text/css";
    if (ext == "json")                 return L"application/json";
    if (ext == "svg")                  return L"image/svg+xml";
    if (ext == "png")                  return L"image/png";
    if (ext == "jpg" || ext == "jpeg") return L"image/jpeg";
    if (ext == "gif")                  return L"image/gif";
    if (ext == "ico")                  return L"image/x-icon";
    if (ext == "woff2")                return L"font/woff2";
    if (ext == "woff")                 return L"font/woff";
    if (ext == "ttf")                  return L"font/ttf";
    return L"application/octet-stream";
}
#endif

// ================================================================
//  Config loader
// ================================================================

static COLORREF parseHexColor(const std::string& hex, COLORREF def = RGB(26,26,46)) {
    if (hex.size() < 7 || hex[0] != '#') return def;
    try {
        int r = std::stoi(hex.substr(1,2), nullptr, 16);
        int g = std::stoi(hex.substr(3,2), nullptr, 16);
        int b = std::stoi(hex.substr(5,2), nullptr, 16);
        return RGB(r, g, b);
    } catch (...) { return def; }
}

static int parseEffectType(const std::string& name) {
    if (name == "mica")     return 2;
    if (name == "acrylic")  return 3;
    if (name == "micaAlt" || name == "tabbed") return 4;
    return 0;
}

static void applyWindowEffect(HWND hwnd, int effectType) {
    // DWMWA_SYSTEMBACKDROP_TYPE = 38 (Windows 11 22H2+)
    DwmSetWindowAttribute(hwnd, 38, &effectType, sizeof(effectType));
    if (effectType >= 2) {
        MARGINS m = {-1, -1, -1, -1};
        DwmExtendFrameIntoClientArea(hwnd, &m);
    }
    if (g_ctrl) {
        ComPtr<ICoreWebView2Controller2> ctrl2;
        if (SUCCEEDED(g_ctrl.As(&ctrl2))) {
            BYTE alpha = (effectType >= 2) ? 0 : 255;
            auto hex = g_cfg.value("/window/backgroundColor"_json_pointer, std::string{"#1a1a2e"});
            auto clr = parseHexColor(hex);
            ctrl2->put_DefaultBackgroundColor({alpha, GetRValue(clr), GetGValue(clr), GetBValue(clr)});
        }
    }
}

// Set DWM visual attributes once. Uses g_bgClr captured at window creation.
// Safe to call again if g_bgClr changes (e.g. window.setBackgroundColor).
static void applyFramelessDwmAttrs() {
    if (!g_frameless || !g_hwnd) return;

    int lum = (GetRValue(g_bgClr)*299 + GetGValue(g_bgClr)*587 + GetBValue(g_bgClr)*114) / 1000;
    BOOL darkMode = (lum < 128) ? TRUE : FALSE;

    // DWMWA_USE_IMMERSIVE_DARK_MODE = 20
    DwmSetWindowAttribute(g_hwnd, 20, &darkMode, sizeof(darkMode));
    // DWMWA_BORDER_COLOR = 34 — concrete color matching bg is more reliable
    // than DWMWA_COLOR_NONE which can flash on defocus on some installs.
    DwmSetWindowAttribute(g_hwnd, 34, &g_bgClr, sizeof(g_bgClr));
    // DWMWA_CAPTION_COLOR = 35
    DwmSetWindowAttribute(g_hwnd, 35, &g_bgClr, sizeof(g_bgClr));

    // Frame margins / backdrop
    if (g_effectType >= 2) {
        MARGINS m = {-1, -1, -1, -1};
        DwmExtendFrameIntoClientArea(g_hwnd, &m);
        DwmSetWindowAttribute(g_hwnd, 38, &g_effectType, sizeof(g_effectType));
    } else {
        MARGINS m = {0, 0, 0, 1};
        DwmExtendFrameIntoClientArea(g_hwnd, &m);
    }
}

static json loadConfig(const std::wstring& dir) {
#ifdef SINGLE_EXE
    auto cfg = loadResourceString(IDR_CONFIG);
    if (!cfg.empty()) {
        try { return json::parse(cfg); } catch (...) {}
    }
#endif
    for (auto& name : { L"\\app.config.json", L"\\..\\app.config.json" }) {
        auto path = dir + name;
        std::ifstream f(path);
        if (f) { json j; f >> j; return j; }
    }
    return json::object();
}

// ================================================================
//  IPC bridge
// ================================================================

using IpcFn = std::function<json(const json&)>;
static std::unordered_map<std::string, IpcFn> g_cmds;

static void ipc_on(const std::string& cmd, IpcFn fn) {
    g_cmds[cmd] = std::move(fn);
}

static void ipc_emit(const std::string& ev, const json& data = {}) {
    if (!g_view) return;
    json m = {{"event", ev}, {"data", data}};
    g_view->PostWebMessageAsJson(U2W(m.dump()).c_str());
}

static json json_paths(const std::vector<std::wstring>& files) {
    json result = json::array();
    for (const auto& file : files) result.push_back(W2U(file));
    return result;
}

static void emit_open_files(const std::vector<std::wstring>& files) {
    if (files.empty()) return;
    ipc_emit("app.openFiles", {{"files", json_paths(files)}});
}

static void emit_open_urls(const std::vector<std::wstring>& urls) {
    if (urls.empty()) return;
    ipc_emit("app.openUrls", {{"urls", json_paths(urls)}});
}

static void ipc_dispatch(LPCWSTR raw) {
    try {
        auto req = json::parse(W2U(raw));
        json resp;
        resp["id"] = req.value("id", -1);
        auto cmd  = req.value("cmd", std::string{});
        auto args = req.value("args", json::object());

        // Permission check
        if (!g_permissions.empty()) {
            auto it = g_permissions.find(cmd);
            if (it == g_permissions.end()) {
                // Check wildcard: "fs.*" matches "fs.readTextFile"
                auto dot = cmd.find('.');
                if (dot != std::string::npos) {
                    auto ns = cmd.substr(0, dot) + ".*";
                    it = g_permissions.find(ns);
                }
            }
            if (it != g_permissions.end() && !it->second) {
                resp["error"] = "permission denied: " + cmd;
                g_view->PostWebMessageAsJson(U2W(resp.dump()).c_str());
                return;
            }
        }

        if (auto it = g_cmds.find(cmd); it != g_cmds.end()) {
            try { resp["result"] = it->second(args); }
            catch (const std::exception& e) { resp["error"] = e.what(); }
        } else {
            resp["error"] = "unknown: " + cmd;
        }
        g_view->PostWebMessageAsJson(U2W(resp.dump()).c_str());
    } catch (...) {}
}

// ================================================================
//  Commands: Window
// ================================================================

static void reg_window() {
    ipc_on("window.setTitle", [](const json& a) -> json {
        SetWindowTextW(g_hwnd, U2W(a.value("title", std::string{})).c_str());
        return true;
    });
    ipc_on("window.minimize", [](const json&) -> json {
        ShowWindow(g_hwnd, SW_MINIMIZE); return true;
    });
    ipc_on("window.maximize", [](const json&) -> json {
        if (!g_resizable) return false;
        WINDOWPLACEMENT wp{sizeof(wp)};
        GetWindowPlacement(g_hwnd, &wp);
        ShowWindow(g_hwnd, wp.showCmd == SW_MAXIMIZE ? SW_RESTORE : SW_MAXIMIZE);
        return true;
    });
    ipc_on("window.restore", [](const json&) -> json {
        ShowWindow(g_hwnd, SW_RESTORE); return true;
    });
    ipc_on("window.close", [](const json&) -> json {
        PostMessageW(g_hwnd, WM_CLOSE, 0, 0); return true;
    });
    ipc_on("window.show", [](const json&) -> json {
        restore_and_focus_window(g_hwnd);
        return true;
    });
    ipc_on("window.hide", [](const json&) -> json {
        ShowWindow(g_hwnd, SW_HIDE); return true;
    });
    ipc_on("window.size", [](const json&) -> json {
        RECT r; GetClientRect(g_hwnd, &r);
        return {{"w", r.right}, {"h", r.bottom}};
    });
    ipc_on("window.setSize", [](const json& a) -> json {
        if (!g_resizable) return false;
        int w = a.value("w", 0), h = a.value("h", 0);
        if (w <= 0 || h <= 0) return false;
        RECT cr, wr;
        GetClientRect(g_hwnd, &cr);
        GetWindowRect(g_hwnd, &wr);
        int fw = (wr.right - wr.left) - cr.right + w;
        int fh = (wr.bottom - wr.top) - cr.bottom + h;
        SetWindowPos(g_hwnd, nullptr, 0, 0, fw, fh, SWP_NOMOVE | SWP_NOZORDER);
        return true;
    });
    ipc_on("window.position", [](const json&) -> json {
        RECT r; GetWindowRect(g_hwnd, &r);
        return {{"x", r.left}, {"y", r.top}};
    });
    ipc_on("window.setPosition", [](const json& a) -> json {
        SetWindowPos(g_hwnd, nullptr, a.value("x", 0), a.value("y", 0), 0, 0,
                     SWP_NOSIZE | SWP_NOZORDER);
        return true;
    });
    ipc_on("window.center", [](const json&) -> json {
        RECT wr; GetWindowRect(g_hwnd, &wr);
        int ww = wr.right - wr.left, wh = wr.bottom - wr.top;
        HMONITOR mon = MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi{sizeof(mi)};
        GetMonitorInfoW(mon, &mi);
        int x = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - ww) / 2;
        int y = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - wh) / 2;
        SetWindowPos(g_hwnd, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
        return true;
    });
    ipc_on("window.setAlwaysOnTop", [](const json& a) -> json {
        HWND z = a.value("top", true) ? HWND_TOPMOST : HWND_NOTOPMOST;
        SetWindowPos(g_hwnd, z, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        return true;
    });
    ipc_on("window.isMaximized", [](const json&) -> json {
        WINDOWPLACEMENT wp{sizeof(wp)};
        GetWindowPlacement(g_hwnd, &wp);
        return wp.showCmd == SW_MAXIMIZE;
    });
    ipc_on("window.setEffect", [](const json& a) -> json {
        auto name = a.value("effect", std::string{"none"});
        g_effectType = parseEffectType(name);
        applyWindowEffect(g_hwnd, g_effectType);
        return true;
    });
    ipc_on("window.setBackgroundColor", [](const json& a) -> json {
        auto hex = a.value("color", std::string{});
        if (hex.empty()) return false;
        COLORREF clr = parseHexColor(hex);
        // Update DWM border + caption colors (via shared helper)
        if (g_frameless) {
            g_bgClr = clr;
            applyFramelessDwmAttrs();
            if (g_bgBrush) DeleteObject(g_bgBrush);
            g_bgBrush = CreateSolidBrush(clr);
            InvalidateRect(g_hwnd, nullptr, TRUE);
        }
        // Update WebView2 default background
        if (g_ctrl) {
            ComPtr<ICoreWebView2Controller2> ctrl2;
            if (SUCCEEDED(g_ctrl.As(&ctrl2)))
                ctrl2->put_DefaultBackgroundColor({255, GetRValue(clr), GetGValue(clr), GetBValue(clr)});
        }
        return true;
    });
}

// ================================================================
//  Commands: Dialogs
// ================================================================

static json show_file_dialog(bool save, const json& a) {
    ComPtr<IFileDialog> dlg;
    HRESULT hr;
    if (save)
        hr = CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&dlg));
    else
        hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&dlg));
    if (FAILED(hr)) throw std::runtime_error("Failed to create file dialog");

    FILEOPENDIALOGOPTIONS opts;
    dlg->GetOptions(&opts);
    bool multi  = !save && a.value("multiple", false);
    bool folder = a.value("folder", false);
    if (multi)  opts |= FOS_ALLOWMULTISELECT;
    if (folder) opts |= FOS_PICKFOLDERS;
    dlg->SetOptions(opts);

    // Filters
    std::vector<COMDLG_FILTERSPEC> specs;
    std::vector<std::wstring> names, pats;
    if (a.contains("filters") && a["filters"].is_array()) {
        for (auto& f : a["filters"]) {
            names.push_back(U2W(f.value("name", "")));
            std::string p;
            for (auto& ext : f["extensions"]) {
                if (!p.empty()) p += ";";
                auto e = ext.get<std::string>();
                p += (e == "*") ? "*.*" : ("*." + e);
            }
            pats.push_back(U2W(p));
        }
        for (size_t i = 0; i < names.size(); i++)
            specs.push_back({names[i].c_str(), pats[i].c_str()});
        dlg->SetFileTypes((UINT)specs.size(), specs.data());
    }

    if (a.contains("defaultName"))
        dlg->SetFileName(U2W(a["defaultName"].get<std::string>()).c_str());

    if (FAILED(dlg->Show(g_hwnd))) return nullptr; // cancelled

    if (multi) {
        ComPtr<IFileOpenDialog> od;
        dlg.As(&od);
        ComPtr<IShellItemArray> items;
        od->GetResults(&items);
        DWORD count; items->GetCount(&count);
        json arr = json::array();
        for (DWORD i = 0; i < count; i++) {
            ComPtr<IShellItem> item;
            items->GetItemAt(i, &item);
            LPWSTR path; item->GetDisplayName(SIGDN_FILESYSPATH, &path);
            arr.push_back(W2U(path));
            CoTaskMemFree(path);
        }
        return arr;
    } else {
        ComPtr<IShellItem> item;
        dlg->GetResult(&item);
        LPWSTR path; item->GetDisplayName(SIGDN_FILESYSPATH, &path);
        auto result = W2U(path);
        CoTaskMemFree(path);
        return result;
    }
}

static void reg_dialog() {
    ipc_on("dialog.openFile", [](const json& a) -> json {
        return show_file_dialog(false, a);
    });
    ipc_on("dialog.saveFile", [](const json& a) -> json {
        return show_file_dialog(true, a);
    });
    ipc_on("dialog.openFolder", [](const json& a) -> json {
        json arg = a.is_null() ? json::object() : a;
        arg["folder"] = true;
        return show_file_dialog(false, arg);
    });
    ipc_on("dialog.message", [](const json& a) -> json {
        auto title   = a.value("title", std::string{"Message"});
        auto message = a.value("message", std::string{});
        auto type    = a.value("type", std::string{"info"});
        UINT flags = MB_OK;
        if (type == "warning")     flags |= MB_ICONWARNING;
        else if (type == "error")  flags |= MB_ICONERROR;
        else                       flags |= MB_ICONINFORMATION;
        MessageBoxW(g_hwnd, U2W(message).c_str(), U2W(title).c_str(), flags);
        return true;
    });
    ipc_on("dialog.confirm", [](const json& a) -> json {
        auto title   = a.value("title", std::string{"Confirm"});
        auto message = a.value("message", std::string{});
        return MessageBoxW(g_hwnd, U2W(message).c_str(), U2W(title).c_str(),
                           MB_YESNO | MB_ICONQUESTION) == IDYES;
    });
}

// ================================================================
//  Commands: File system
// ================================================================

static void reg_fs() {
    ipc_on("fs.createGlbPreview", [](const json& a) -> json {
        auto path = U2W(a.value("path", std::string{}));
        if (path.empty()) throw std::runtime_error("Missing path");
        const auto protocol = a.value("protocol", std::string{"http:"});
        const uint64_t minBytes = a.value("minBytes", static_cast<uint64_t>(512ull * 1024ull * 1024ull));
        return create_glb_preview_file(path, protocol, minBytes);
    });
    ipc_on("fs.createGlbAnimationClip", [](const json& a) -> json {
        auto path = U2W(a.value("path", std::string{}));
        if (path.empty()) throw std::runtime_error("Missing path");
        const auto protocol = a.value("protocol", std::string{"http:"});
        const int animationIndex = a.value("animationIndex", -1);
        if (animationIndex < 0) throw std::runtime_error("Missing animation index");
        return create_glb_preview_file(path, protocol, 0, animationIndex);
    });
    ipc_on("fs.localFileUrl", [](const json& a) -> json {
        auto path = U2W(a.value("path", std::string{}));
        if (path.empty()) throw std::runtime_error("Missing path");
        if (!fspath::exists(path) || !fspath::is_regular_file(path)) {
            throw std::runtime_error("Cannot open: " + W2U(path));
        }

        const auto token = make_local_file_token();
        {
            std::lock_guard<std::mutex> lock(g_localFileTokensMutex);
            g_localFileTokens[token] = fspath::absolute(path).wstring();
        }

        const auto protocol = a.value("protocol", std::string{"http:"}) == "https:"
            ? std::string{"https"}
            : std::string{"http"};
        return protocol + "://app.localhost/__meshscope_file__/" + token;
    });
    ipc_on("fs.readTextFile", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        std::ifstream f(U2W(path), std::ios::binary);
        if (!f) throw std::runtime_error("Cannot open: " + path);
        return std::string((std::istreambuf_iterator<char>(f)), {});
    });
    ipc_on("fs.readBase64File", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        std::ifstream f(U2W(path), std::ios::binary);
        if (!f) throw std::runtime_error("Cannot open: " + path);
        auto content = std::string((std::istreambuf_iterator<char>(f)), {});
        return base64_encode(content);
    });
    ipc_on("fs.writeTextFile", [](const json& a) -> json {
        auto path    = a.value("path", std::string{});
        auto content = a.value("content", std::string{});
        std::ofstream f(U2W(path), std::ios::binary);
        if (!f) throw std::runtime_error("Cannot write: " + path);
        f.write(content.data(), content.size());
        return true;
    });
    ipc_on("fs.writeBase64File", [](const json& a) -> json {
        auto path    = a.value("path", std::string{});
        auto content = base64_decode(a.value("content", std::string{}));
        std::ofstream f(U2W(path), std::ios::binary);
        if (!f) throw std::runtime_error("Cannot write: " + path);
        f.write(content.data(), content.size());
        return true;
    });
    ipc_on("fs.exists", [](const json& a) -> json {
        return fspath::exists(U2W(a.value("path", std::string{})));
    });
    ipc_on("fs.readDir", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        json entries = json::array();
        for (auto& e : fspath::directory_iterator(U2W(path))) {
            entries.push_back({
                {"name",   W2U(e.path().filename().wstring())},
                {"isDir",  e.is_directory()},
                {"isFile", e.is_regular_file()},
            });
        }
        return entries;
    });
    ipc_on("fs.mkdir", [](const json& a) -> json {
        fspath::create_directories(U2W(a.value("path", std::string{})));
        return true;
    });
    ipc_on("fs.remove", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        if (path.empty() || path == "/" || path == "\\" || (path.size() <= 3 && path[1] == ':'))
            throw std::runtime_error("Refusing to remove root/drive path");
        fspath::remove_all(U2W(path));
        return true;
    });
    ipc_on("fs.rename", [](const json& a) -> json {
        fspath::rename(U2W(a.value("from", std::string{})),
                       U2W(a.value("to", std::string{})));
        return true;
    });
    ipc_on("fs.stat", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        WIN32_FILE_ATTRIBUTE_DATA d;
        if (!GetFileAttributesExW(U2W(path).c_str(), GetFileExInfoStandard, &d))
            throw std::runtime_error("Not found: " + path);
        ULARGE_INTEGER sz; sz.HighPart = d.nFileSizeHigh; sz.LowPart = d.nFileSizeLow;
        ULARGE_INTEGER ft; ft.HighPart = d.ftLastWriteTime.dwHighDateTime;
        ft.LowPart = d.ftLastWriteTime.dwLowDateTime;
        int64_t ts = (ft.QuadPart - 116444736000000000LL) / 10000000LL;
        bool isDir = (d.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        return {{"size", sz.QuadPart}, {"modified", ts}, {"isDir", isDir}, {"isFile", !isDir}};
    });
}

// ================================================================
//  Commands: Clipboard
// ================================================================

static void reg_clipboard() {
    ipc_on("clipboard.readText", [](const json&) -> json {
        if (!OpenClipboard(g_hwnd)) return nullptr;
        HANDLE h = GetClipboardData(CF_UNICODETEXT);
        if (!h) { CloseClipboard(); return nullptr; }
        auto text = W2U(static_cast<LPCWSTR>(GlobalLock(h)));
        GlobalUnlock(h);
        CloseClipboard();
        return text;
    });
    ipc_on("clipboard.writeText", [](const json& a) -> json {
        auto text = U2W(a.value("text", std::string{}));
        if (!OpenClipboard(g_hwnd)) return false;
        EmptyClipboard();
        size_t bytes = (text.size() + 1) * sizeof(wchar_t);
        HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if (h) {
            memcpy(GlobalLock(h), text.c_str(), bytes);
            GlobalUnlock(h);
            SetClipboardData(CF_UNICODETEXT, h);
        }
        CloseClipboard();
        return true;
    });
}

// ================================================================
//  Commands: Shell & App
// ================================================================

static void write_reg_string(
    HKEY root,
    const std::wstring& path,
    const std::wstring& name,
    const std::wstring& value
) {
    HKEY hKey = nullptr;
    if (RegCreateKeyExW(root, path.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &hKey, nullptr) != ERROR_SUCCESS)
        throw std::runtime_error("Cannot open registry key");

    auto* valueName = name.empty() ? nullptr : name.c_str();
    auto result = RegSetValueExW(
        hKey,
        valueName,
        0,
        REG_SZ,
        reinterpret_cast<const BYTE*>(value.c_str()),
        static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))
    );
    RegCloseKey(hKey);
    if (result != ERROR_SUCCESS)
        throw std::runtime_error("Cannot write registry value");
}

static std::wstring normalize_extension(const std::string& ext) {
    std::wstring value = U2W(ext);
    if (value.empty()) return value;
    if (value.front() != L'.') value.insert(value.begin(), L'.');
    for (auto& ch : value) ch = static_cast<wchar_t>(towlower(ch));
    return value;
}

static bool register_file_associations(const std::vector<std::string>& exts) {
    if (exts.empty()) return false;

    const auto currentExe = exe_path();
    const auto exeName = fspath::path(currentExe).filename().wstring();
    const auto appTitle = U2W(g_cfg.value("/window/title"_json_pointer, std::string{"MeshScope 3D"}));
    const auto progId = std::wstring(L"MeshScope3D.Model");
    const auto classesRoot = std::wstring(L"Software\\Classes\\");
    const auto capabilitiesPath = classesRoot + L"Applications\\" + exeName + L"\\Capabilities";
    const auto openCommand = L"\"" + currentExe + L"\" \"%1\"";

    write_reg_string(HKEY_CURRENT_USER, classesRoot + L"Applications\\" + exeName, L"FriendlyAppName", appTitle);
    write_reg_string(HKEY_CURRENT_USER, L"Software\\RegisteredApplications", appTitle, capabilitiesPath);
    write_reg_string(HKEY_CURRENT_USER, capabilitiesPath, L"ApplicationName", appTitle);
    write_reg_string(HKEY_CURRENT_USER, capabilitiesPath, L"ApplicationDescription", appTitle + L" 3D 模型查看器");
    write_reg_string(
        HKEY_CURRENT_USER,
        classesRoot + L"Applications\\" + exeName + L"\\shell\\open\\command",
        L"",
        openCommand
    );

    write_reg_string(HKEY_CURRENT_USER, classesRoot + progId, L"", appTitle + L" 支持文件");
    write_reg_string(HKEY_CURRENT_USER, classesRoot + progId + L"\\DefaultIcon", L"", L"\"" + currentExe + L"\",0");
    write_reg_string(HKEY_CURRENT_USER, classesRoot + progId + L"\\shell\\open\\command", L"", openCommand);

    for (const auto& ext : exts) {
        const auto normalized = normalize_extension(ext);
        if (normalized.empty()) continue;
        write_reg_string(
            HKEY_CURRENT_USER,
            classesRoot + L"Applications\\" + exeName + L"\\SupportedTypes",
            normalized,
            L""
        );
        write_reg_string(
            HKEY_CURRENT_USER,
            classesRoot + normalized + L"\\OpenWithProgids",
            progId,
            L""
        );
        write_reg_string(
            HKEY_CURRENT_USER,
            capabilitiesPath + L"\\FileAssociations",
            normalized,
            progId
        );
    }

    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return true;
}

static void reg_shell_app() {
    ipc_on("shell.open", [](const json& a) -> json {
        auto url = a.value("url", std::string{});
        if (url.empty()) return false;
        ShellExecuteW(nullptr, L"open", U2W(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        return true;
    });
    ipc_on("shell.execute", [](const json& a) -> json {
        auto program = a.value("program", std::string{});
        if (program.empty()) throw std::runtime_error("program is required");
        std::wstring args;
        if (a.contains("args") && a["args"].is_array()) {
            for (auto& arg : a["args"]) {
                if (!args.empty()) args += L' ';
                auto s = U2W(arg.get<std::string>());
                if (s.find(L' ') != std::wstring::npos)
                    args += L'"' + s + L'"';
                else
                    args += s;
            }
        }
        auto ret = (INT_PTR)ShellExecuteW(nullptr, nullptr, U2W(program).c_str(),
                                          args.empty() ? nullptr : args.c_str(),
                                          nullptr, SW_SHOWNORMAL);
        return ret > 32;
    });
    ipc_on("app.exit", [](const json& a) -> json {
        PostQuitMessage(a.value("code", 0));
        return true;
    });
    ipc_on("app.dataDir", [](const json&) -> json {
        return W2U(app_data_dir());
    });
    ipc_on("app.consumeLaunchFiles", [](const json&) -> json {
        g_frontendReady = true;
        auto files = json_paths(g_pendingLaunchFiles);
        g_pendingLaunchFiles.clear();
        return files;
    });
    ipc_on("app.consumeLaunchUrls", [](const json&) -> json {
        g_frontendReady = true;
        auto urls = json_paths(g_pendingLaunchUrls);
        g_pendingLaunchUrls.clear();
        return urls;
    });
    ipc_on("app.registerFileAssociations", [](const json& a) -> json {
        if (!a.contains("extensions") || !a["extensions"].is_array()) return false;
        std::vector<std::string> exts;
        for (const auto& entry : a["extensions"]) {
            if (!entry.is_string()) continue;
            exts.push_back(entry.get<std::string>());
        }
        return register_file_associations(exts);
    });
    ipc_on("window.startDrag", [](const json&) -> json {
        ReleaseCapture();
        SendMessageW(g_hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        return true;
    });
    // Start a native resize drag. Frontend detects mouse near window edge and
    // calls this on mousedown — Windows then drives the resize (correct cursors,
    // snap, aero-shake). WebView2 fills the entire client area for zero visual
    // chrome around the content.
    ipc_on("window.startResize", [](const json& a) -> json {
        if (!g_hwnd) return false;
        if (!g_resizable || IsZoomed(g_hwnd)) return false;
        auto edge = a.value("edge", std::string{});
        WPARAM hit = 0;
        if      (edge == "left")         hit = HTLEFT;
        else if (edge == "right")        hit = HTRIGHT;
        else if (edge == "top")          hit = HTTOP;
        else if (edge == "bottom")       hit = HTBOTTOM;
        else if (edge == "top-left")     hit = HTTOPLEFT;
        else if (edge == "top-right")    hit = HTTOPRIGHT;
        else if (edge == "bottom-left")  hit = HTBOTTOMLEFT;
        else if (edge == "bottom-right") hit = HTBOTTOMRIGHT;
        if (!hit) return false;
        ReleaseCapture();
        POINT pt{};
        GetCursorPos(&pt);
        PostMessageW(g_hwnd, WM_NCLBUTTONDOWN, hit, MAKELPARAM(pt.x, pt.y));
        return true;
    });
    ipc_on("window.getConfig", [](const json&) -> json {
        return g_cfg;
    });
    ipc_on("window.isFrameless", [](const json&) -> json {
        return g_frameless;
    });
}

// ================================================================
//  Commands: Environment variables
// ================================================================

static void reg_env() {
    ipc_on("env.get", [](const json& a) -> json {
        auto name = a.value("name", std::string{});
        wchar_t buf[32768];
        DWORD len = GetEnvironmentVariableW(U2W(name).c_str(), buf, 32768);
        if (len == 0) return nullptr;
        return W2U(buf);
    });
    ipc_on("env.getAll", [](const json&) -> json {
        json result = json::object();
        auto env = GetEnvironmentStringsW();
        if (!env) return result;
        for (auto p = env; *p; p += wcslen(p) + 1) {
            auto s = W2U(p);
            auto eq = s.find('=');
            if (eq != std::string::npos && eq > 0)
                result[s.substr(0, eq)] = s.substr(eq + 1);
        }
        FreeEnvironmentStringsW(env);
        return result;
    });
}

// ================================================================
//  Commands: Global hotkeys
// ================================================================

static void reg_hotkey() {
    ipc_on("hotkey.register", [](const json& a) -> json {
        int id  = a.value("id", 0);
        int mod = a.value("modifiers", 0); // MOD_ALT=1, MOD_CONTROL=2, MOD_SHIFT=4, MOD_WIN=8
        int key = a.value("key", 0);       // Virtual key code
        bool ok = RegisterHotKey(g_hwnd, id, mod | MOD_NOREPEAT, key);
        return ok;
    });
    ipc_on("hotkey.unregister", [](const json& a) -> json {
        return (bool)UnregisterHotKey(g_hwnd, a.value("id", 0));
    });
    ipc_on("hotkey.unregisterAll", [](const json&) -> json {
        // Unregister IDs 1..100
        for (int i = 1; i <= 100; i++) UnregisterHotKey(g_hwnd, i);
        return true;
    });
}

// ================================================================
//  Commands: Notifications
// ================================================================

static void reg_notification() {
    ipc_on("notification.show", [](const json& a) -> json {
        auto title = U2W(a.value("title", std::string{"通知"}));
        auto body  = U2W(a.value("body", std::string{}));
        // Use tray balloon if tray is active
        if (g_trayActive) {
            g_nid.uFlags |= NIF_INFO;
            wcsncpy_s(g_nid.szInfoTitle, title.c_str(), _TRUNCATE);
            wcsncpy_s(g_nid.szInfo, body.c_str(), _TRUNCATE);
            g_nid.dwInfoFlags = NIIF_INFO;
            Shell_NotifyIconW(NIM_MODIFY, &g_nid);
            return true;
        }
        // Create temporary tray icon for notification
        NOTIFYICONDATAW nid{sizeof(nid)};
        nid.hWnd  = g_hwnd;
        nid.uID   = 99;
        nid.uFlags = NIF_ICON | NIF_INFO;
        nid.hIcon  = LoadIconW(nullptr, IDI_APPLICATION);
        wcsncpy_s(nid.szInfoTitle, title.c_str(), _TRUNCATE);
        wcsncpy_s(nid.szInfo, body.c_str(), _TRUNCATE);
        nid.dwInfoFlags = NIIF_INFO;
        Shell_NotifyIconW(NIM_ADD, &nid);
        // Remove after a delay (fire-and-forget via timer)
        SetTimer(g_hwnd, 99, 5000, [](HWND h, UINT, UINT_PTR id, DWORD) {
            NOTIFYICONDATAW nid{sizeof(nid)};
            nid.hWnd = h; nid.uID = 99;
            Shell_NotifyIconW(NIM_DELETE, &nid);
            KillTimer(h, id);
        });
        return true;
    });
}

// ================================================================
//  Commands: Context menu
// ================================================================

static void reg_menu() {
    ipc_on("menu.popup", [](const json& a) -> json {
        if (!a.contains("items") || !a["items"].is_array()) return nullptr;
        HMENU hMenu = CreatePopupMenu();
        int idx = 1;
        for (auto& item : a["items"]) {
            if (item.is_string() && item.get<std::string>() == "-") {
                AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
            } else if (item.is_object()) {
                auto label = U2W(item.value("label", std::string{""}));
                UINT flags = MF_STRING;
                if (item.value("disabled", false)) flags |= MF_GRAYED;
                if (item.value("checked", false))  flags |= MF_CHECKED;
                AppendMenuW(hMenu, flags, idx, label.c_str());
            }
            idx++;
        }
        POINT pt;
        GetCursorPos(&pt);
        SetForegroundWindow(g_hwnd);
        int cmd = TrackPopupMenuEx(hMenu, TPM_RETURNCMD | TPM_NONOTIFY,
                                    pt.x, pt.y, g_hwnd, nullptr);
        DestroyMenu(hMenu);
        if (cmd == 0) return nullptr; // cancelled
        return cmd - 1; // 0-based index
    });
}

// ================================================================
//  Commands: HTTP client
// ================================================================

static void reg_http() {
    ipc_on("http.request", [](const json& a) -> json {
        auto url    = a.value("url", std::string{});
        auto method = a.value("method", std::string{"GET"});
        auto body   = a.value("body", std::string{});
        auto hdrs   = a.value("headers", json::object());

        if (url.empty()) throw std::runtime_error("url is required");

        // Parse URL
        auto wUrl = U2W(url);
        URL_COMPONENTS uc{sizeof(uc)};
        wchar_t host[256]{}, path[2048]{};
        uc.lpszHostName  = host;   uc.dwHostNameLength  = 256;
        uc.lpszUrlPath   = path;   uc.dwUrlPathLength   = 2048;
        if (!WinHttpCrackUrl(wUrl.c_str(), 0, 0, &uc))
            throw std::runtime_error("Invalid URL");

        bool https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
        HINTERNET hSession = WinHttpOpen(L"QQ/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!hSession) throw std::runtime_error("WinHttpOpen failed");

        HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
        if (!hConnect) { WinHttpCloseHandle(hSession); throw std::runtime_error("WinHttpConnect failed"); }

        auto wMethod = U2W(method);
        HINTERNET hRequest = WinHttpOpenRequest(hConnect, wMethod.c_str(), path,
                                                 nullptr, WINHTTP_NO_REFERER,
                                                 WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                 https ? WINHTTP_FLAG_SECURE : 0);
        if (!hRequest) {
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            throw std::runtime_error("WinHttpOpenRequest failed");
        }

        // Add custom headers
        std::wstring allHeaders;
        for (auto& [k, v] : hdrs.items()) {
            allHeaders += U2W(k) + L": " + U2W(v.get<std::string>()) + L"\r\n";
        }
        if (!allHeaders.empty())
            WinHttpAddRequestHeaders(hRequest, allHeaders.c_str(), (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);

        // Send
        LPVOID bodyPtr = body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data();
        DWORD bodyLen  = body.empty() ? 0 : (DWORD)body.size();
        if (!WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, bodyPtr, bodyLen, bodyLen, 0) ||
            !WinHttpReceiveResponse(hRequest, nullptr)) {
            WinHttpCloseHandle(hRequest);
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            throw std::runtime_error("HTTP request failed");
        }

        // Status code
        DWORD statusCode = 0, sz = sizeof(statusCode);
        WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);

        // Response headers
        DWORD hdrSize = 0;
        WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_RAW_HEADERS_CRLF,
                            WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &hdrSize, WINHTTP_NO_HEADER_INDEX);
        std::wstring respHdrs(hdrSize / sizeof(wchar_t), 0);
        WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_RAW_HEADERS_CRLF,
                            WINHTTP_HEADER_NAME_BY_INDEX, respHdrs.data(), &hdrSize, WINHTTP_NO_HEADER_INDEX);

        // Response body
        std::string respBody;
        DWORD available, read;
        while (WinHttpQueryDataAvailable(hRequest, &available) && available > 0) {
            std::string chunk(available, 0);
            WinHttpReadData(hRequest, chunk.data(), available, &read);
            chunk.resize(read);
            respBody += chunk;
        }

        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);

        return json{{"status", statusCode}, {"headers", W2U(respHdrs)}, {"body", respBody}};
    });
}

// ================================================================
//  Commands: Special directories & OS info
// ================================================================

static std::wstring getKnownFolder(REFKNOWNFOLDERID id) {
    PWSTR p = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) {
        std::wstring s(p);
        CoTaskMemFree(p);
        return s;
    }
    return {};
}

static void reg_os() {
    ipc_on("os.platform", [](const json&) -> json { return "windows"; });
    ipc_on("os.arch", [](const json&) -> json {
        SYSTEM_INFO si; GetNativeSystemInfo(&si);
        switch (si.wProcessorArchitecture) {
            case PROCESSOR_ARCHITECTURE_AMD64: return "x64";
            case PROCESSOR_ARCHITECTURE_ARM64: return "arm64";
            case PROCESSOR_ARCHITECTURE_INTEL: return "x86";
            default: return "unknown";
        }
    });
    ipc_on("os.version", [](const json&) -> json {
        OSVERSIONINFOEXW vi{sizeof(vi)};
        // Use RtlGetVersion to bypass deprecation
        using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOEXW*);
        auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
        if (fn) fn(&vi);
        return std::to_string(vi.dwMajorVersion) + "." +
               std::to_string(vi.dwMinorVersion) + "." +
               std::to_string(vi.dwBuildNumber);
    });
    ipc_on("os.hostname", [](const json&) -> json {
        wchar_t buf[256]; DWORD sz = 256;
        GetComputerNameW(buf, &sz);
        return W2U(buf);
    });
    ipc_on("os.username", [](const json&) -> json {
        wchar_t buf[256]; DWORD sz = 256;
        GetUserNameW(buf, &sz);
        return W2U(buf);
    });
    ipc_on("os.locale", [](const json&) -> json {
        wchar_t buf[85]; GetUserDefaultLocaleName(buf, 85);
        return W2U(buf);
    });

    // Special folders
    ipc_on("path.home", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_Profile));
    });
    ipc_on("path.documents", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_Documents));
    });
    ipc_on("path.desktop", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_Desktop));
    });
    ipc_on("path.downloads", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_Downloads));
    });
    ipc_on("path.appData", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_RoamingAppData));
    });
    ipc_on("path.localAppData", [](const json&) -> json {
        return W2U(getKnownFolder(FOLDERID_LocalAppData));
    });
    ipc_on("path.temp", [](const json&) -> json {
        DWORD cap = GetTempPathW(0, nullptr);
        if (cap == 0) cap = MAX_PATH;
        std::wstring buf(cap, L'\0');
        for (;;) {
            DWORD len = GetTempPathW(static_cast<DWORD>(buf.size()), buf.data());
            if (len == 0) return std::string{};
            if (len < buf.size()) {
                buf.resize(len);
                return W2U(buf);
            }
            buf.assign(len + 1, L'\0');
        }
    });
}

// ================================================================
//  Commands: File watcher
// ================================================================

static DWORD WINAPI watchThread(LPVOID param) {
    auto* w = (FileWatcher*)param;
    BYTE buf[4096];
    while (w->active) {
        DWORD bytes = 0;
        if (ReadDirectoryChangesW(w->hDir, buf, sizeof(buf), TRUE,
            FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
            FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE |
            FILE_NOTIFY_CHANGE_CREATION,
            &bytes, nullptr, nullptr))
        {
            auto* info = (FILE_NOTIFY_INFORMATION*)buf;
            while (info && w->active) {
                std::wstring name(info->FileName, info->FileNameLength / sizeof(wchar_t));
                const char* action = "unknown";
                switch (info->Action) {
                    case FILE_ACTION_ADDED:            action = "created"; break;
                    case FILE_ACTION_REMOVED:          action = "deleted"; break;
                    case FILE_ACTION_MODIFIED:         action = "modified"; break;
                    case FILE_ACTION_RENAMED_OLD_NAME: action = "renamed"; break;
                    case FILE_ACTION_RENAMED_NEW_NAME: action = "renamed"; break;
                }
                // Post to main thread
                PostMessageW(g_hwnd, WM_FILE_CHANGED, w->id, (LPARAM)new json{
                    {"id", w->id}, {"action", action}, {"path", W2U(name)}
                });
                if (info->NextEntryOffset == 0) break;
                info = (FILE_NOTIFY_INFORMATION*)((BYTE*)info + info->NextEntryOffset);
            }
        } else {
            break;
        }
    }
    return 0;
}

static void reg_watcher() {
    ipc_on("watcher.start", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        if (path.empty()) throw std::runtime_error("path is required");
        auto wpath = U2W(path);
        HANDLE hDir = CreateFileW(wpath.c_str(), FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (hDir == INVALID_HANDLE_VALUE)
            throw std::runtime_error("Cannot watch: " + path);

        int id = g_nextWatchId++;
        auto* w = new FileWatcher{hDir, nullptr, wpath, id, true};
        w->hThread = CreateThread(nullptr, 0, watchThread, w, 0, nullptr);
        g_watchers[id] = w;
        return id;
    });
    ipc_on("watcher.stop", [](const json& a) -> json {
        int id = a.value("id", 0);
        auto it = g_watchers.find(id);
        if (it == g_watchers.end()) return false;
        auto* w = it->second;
        w->active = false;
        CancelIoEx(w->hDir, nullptr);
        WaitForSingleObject(w->hThread, 1000);
        CloseHandle(w->hThread);
        CloseHandle(w->hDir);
        delete w;
        g_watchers.erase(it);
        return true;
    });
}

// ================================================================
//  Commands: Window state persistence
// ================================================================

static std::wstring g_stateFile;

static void saveWindowState() {
    if (g_stateFile.empty()) return;
    WINDOWPLACEMENT wp{sizeof(wp)};
    GetWindowPlacement(g_hwnd, &wp);
    json state = {
        {"x",         wp.rcNormalPosition.left},
        {"y",         wp.rcNormalPosition.top},
        {"w",         wp.rcNormalPosition.right - wp.rcNormalPosition.left},
        {"h",         wp.rcNormalPosition.bottom - wp.rcNormalPosition.top},
        {"maximized", wp.showCmd == SW_MAXIMIZE},
    };
    std::ofstream f(g_stateFile, std::ios::binary);
    if (f) f << state.dump(2);
}

static json loadWindowState() {
    if (g_stateFile.empty()) return {};
    std::ifstream f(g_stateFile);
    if (!f) return {};
    try { json j; f >> j; return j; }
    catch (...) { return {}; }
}

static RECT clampWindowRectToWorkArea(RECT rect, int minW, int minH) {
    HMONITOR mon = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
    if (!mon) mon = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);

    MONITORINFO mi{sizeof(mi)};
    if (!GetMonitorInfoW(mon, &mi)) return rect;

    const int workW = mi.rcWork.right - mi.rcWork.left;
    const int workH = mi.rcWork.bottom - mi.rcWork.top;
    int width = std::clamp(static_cast<int>(rect.right - rect.left), minW, std::max(minW, workW));
    int height = std::clamp(static_cast<int>(rect.bottom - rect.top), minH, std::max(minH, workH));
    int left = width >= workW
        ? mi.rcWork.left
        : std::clamp(rect.left, mi.rcWork.left, mi.rcWork.right - width);
    int top = height >= workH
        ? mi.rcWork.top
        : std::clamp(rect.top, mi.rcWork.top, mi.rcWork.bottom - height);

    return {left, top, left + width, top + height};
}

static void reg_state() {
    ipc_on("window.saveState", [](const json&) -> json {
        saveWindowState();
        return true;
    });
    ipc_on("window.loadState", [](const json&) -> json {
        return loadWindowState();
    });
}

// ================================================================
//  DevTools toggle
// ================================================================

static void reg_devtools() {
    ipc_on("devtools.open", [](const json&) -> json {
        if (g_view) g_view->OpenDevToolsWindow();
        return true;
    });
    ipc_on("devtools.close", [](const json&) -> json {
        // WebView2 doesn't have a direct close devtools API
        // but opening when already open just focuses
        return true;
    });
}

// ================================================================
//  Commands: System tray
// ================================================================

static void reg_tray() {
    ipc_on("tray.create", [](const json& a) -> json {
        if (g_trayActive) return true;
        g_nid.cbSize           = sizeof(g_nid);
        g_nid.hWnd             = g_hwnd;
        g_nid.uID              = 1;
        g_nid.uFlags           = NIF_ICON | NIF_TIP | NIF_MESSAGE;
        g_nid.uCallbackMessage = WM_TRAYICON;
        g_nid.hIcon            = LoadIconW(nullptr, IDI_APPLICATION);
        auto tip = U2W(a.value("tooltip", std::string{"App"}));
        wcsncpy_s(g_nid.szTip, tip.c_str(), _TRUNCATE);
        Shell_NotifyIconW(NIM_ADD, &g_nid);
        g_trayActive = true;
        return true;
    });
    ipc_on("tray.setTooltip", [](const json& a) -> json {
        if (!g_trayActive) return false;
        auto tip = U2W(a.value("tooltip", std::string{"App"}));
        wcsncpy_s(g_nid.szTip, tip.c_str(), _TRUNCATE);
        Shell_NotifyIconW(NIM_MODIFY, &g_nid);
        return true;
    });
    ipc_on("tray.remove", [](const json&) -> json {
        if (!g_trayActive) return false;
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        g_trayActive = false;
        return true;
    });
}

// ================================================================
//  Commands: Registry
// ================================================================

static HKEY parseRootKey(const std::string& root) {
    if (root == "HKCU" || root == "HKEY_CURRENT_USER")   return HKEY_CURRENT_USER;
    if (root == "HKLM" || root == "HKEY_LOCAL_MACHINE")   return HKEY_LOCAL_MACHINE;
    if (root == "HKCR" || root == "HKEY_CLASSES_ROOT")    return HKEY_CLASSES_ROOT;
    if (root == "HKU"  || root == "HKEY_USERS")           return HKEY_USERS;
    return HKEY_CURRENT_USER;
}

static void reg_registry() {
    ipc_on("registry.read", [](const json& a) -> json {
        auto root = a.value("root", std::string{"HKCU"});
        auto path = a.value("path", std::string{});
        auto name = a.value("name", std::string{});
        HKEY hKey;
        if (RegOpenKeyExW(parseRootKey(root), U2W(path).c_str(), 0, KEY_READ, &hKey) != ERROR_SUCCESS)
            return nullptr;
        DWORD type, size = 0;
        auto wName = U2W(name);
        RegQueryValueExW(hKey, wName.c_str(), nullptr, &type, nullptr, &size);
        if (size == 0) { RegCloseKey(hKey); return nullptr; }
        std::vector<BYTE> buf(size);
        RegQueryValueExW(hKey, wName.c_str(), nullptr, &type, buf.data(), &size);
        RegCloseKey(hKey);
        switch (type) {
            case REG_SZ:
            case REG_EXPAND_SZ:
                return W2U(reinterpret_cast<wchar_t*>(buf.data()));
            case REG_DWORD:
                return (int)*reinterpret_cast<DWORD*>(buf.data());
            case REG_QWORD:
                return (int64_t)*reinterpret_cast<uint64_t*>(buf.data());
            default:
                return nullptr;
        }
    });
    ipc_on("registry.write", [](const json& a) -> json {
        auto root  = a.value("root", std::string{"HKCU"});
        auto path  = a.value("path", std::string{});
        auto name  = a.value("name", std::string{});
        auto value = a["value"];
        HKEY hKey;
        if (RegCreateKeyExW(parseRootKey(root), U2W(path).c_str(), 0, nullptr,
            0, KEY_WRITE, nullptr, &hKey, nullptr) != ERROR_SUCCESS)
            throw std::runtime_error("Cannot open registry key");
        auto wName = U2W(name);
        LONG result;
        if (value.is_string()) {
            auto wVal = U2W(value.get<std::string>());
            result = RegSetValueExW(hKey, wName.c_str(), 0, REG_SZ,
                (const BYTE*)wVal.c_str(), (DWORD)((wVal.size()+1)*sizeof(wchar_t)));
        } else if (value.is_number_integer()) {
            DWORD dw = (DWORD)value.get<int>();
            result = RegSetValueExW(hKey, wName.c_str(), 0, REG_DWORD, (const BYTE*)&dw, sizeof(dw));
        } else {
            RegCloseKey(hKey);
            throw std::runtime_error("Unsupported value type");
        }
        RegCloseKey(hKey);
        return result == ERROR_SUCCESS;
    });
    ipc_on("registry.delete", [](const json& a) -> json {
        auto root = a.value("root", std::string{"HKCU"});
        auto path = a.value("path", std::string{});
        auto name = a.value("name", std::string{});
        if (name.empty()) {
            // Delete entire key
            return RegDeleteTreeW(parseRootKey(root), U2W(path).c_str()) == ERROR_SUCCESS;
        }
        HKEY hKey;
        if (RegOpenKeyExW(parseRootKey(root), U2W(path).c_str(), 0, KEY_WRITE, &hKey) != ERROR_SUCCESS)
            return false;
        auto result = RegDeleteValueW(hKey, U2W(name).c_str());
        RegCloseKey(hKey);
        return result == ERROR_SUCCESS;
    });
    ipc_on("registry.exists", [](const json& a) -> json {
        auto root = a.value("root", std::string{"HKCU"});
        auto path = a.value("path", std::string{});
        HKEY hKey;
        if (RegOpenKeyExW(parseRootKey(root), U2W(path).c_str(), 0, KEY_READ, &hKey) != ERROR_SUCCESS)
            return false;
        RegCloseKey(hKey);
        return true;
    });
}

// ================================================================
//  Commands: Deep link / URL protocol
// ================================================================

static void reg_protocol() {
    ipc_on("protocol.register", [](const json& a) -> json {
        auto scheme = a.value("scheme", std::string{});
        auto desc   = a.value("description", scheme + " Protocol");
        if (scheme.empty()) throw std::runtime_error("scheme is required");
        if (!is_valid_protocol_scheme(scheme)) throw std::runtime_error("invalid or reserved protocol scheme");

        auto currentExe = exe_path();

        auto wScheme = U2W(scheme);
        auto regPath = L"Software\\Classes\\" + wScheme;

        auto wDesc = U2W(desc);
        write_reg_string(HKEY_CURRENT_USER, regPath, L"", wDesc);
        write_reg_string(HKEY_CURRENT_USER, regPath, L"URL Protocol", L"");

        // Create shell\open\command key
        auto cmdPath = regPath + L"\\shell\\open\\command";
        auto cmd = L"\"" + currentExe + L"\" --protocol \"%1\"";
        write_reg_string(HKEY_CURRENT_USER, cmdPath, L"", cmd);
        return true;
    });
    ipc_on("protocol.unregister", [](const json& a) -> json {
        auto scheme = a.value("scheme", std::string{});
        if (scheme.empty()) throw std::runtime_error("scheme is required");
        auto regPath = L"Software\\Classes\\" + U2W(scheme);
        return RegDeleteTreeW(HKEY_CURRENT_USER, regPath.c_str()) == ERROR_SUCCESS;
    });
}

// ================================================================
//  Commands: Logging
// ================================================================

static void writeLog(const std::string& level, const std::string& msg) {
    if (g_logFile.empty()) return;
    std::lock_guard<std::mutex> lock(g_logMtx);
    std::ofstream f(g_logFile, std::ios::app);
    if (!f) return;
    SYSTEMTIME st; GetLocalTime(&st);
    char ts[32];
    snprintf(ts, sizeof(ts), "%04d-%02d-%02d %02d:%02d:%02d.%03d",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    f << "[" << ts << "] [" << level << "] " << msg << "\n";
}

static void reg_log() {
    ipc_on("log.setFile", [](const json& a) -> json {
        auto path = a.value("path", std::string{});
        if (path.empty()) {
            // Default to data/app.log
            g_logFile = app_data_dir() + L"\\app.log";
        } else {
            g_logFile = U2W(path);
        }
        // Ensure parent directory exists
        auto parent = fspath::path(g_logFile).parent_path();
        fspath::create_directories(parent);
        return W2U(g_logFile);
    });
    ipc_on("log.write", [](const json& a) -> json {
        auto level = a.value("level", std::string{"info"});
        auto msg   = a.value("message", std::string{});
        writeLog(level, msg);
        return true;
    });
    ipc_on("log.clear", [](const json&) -> json {
        if (g_logFile.empty()) return false;
        std::ofstream f(g_logFile, std::ios::trunc);
        return f.good();
    });
    ipc_on("log.getPath", [](const json&) -> json {
        return g_logFile.empty() ? nullptr : json(W2U(g_logFile));
    });
}

// ================================================================
//  Commands: Auto-update
// ================================================================

static json httpGet(const std::string& url) {
    auto wUrl = U2W(url);
    URL_COMPONENTS uc{sizeof(uc)};
    wchar_t host[256]{}, path[2048]{};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2048;
    if (!WinHttpCrackUrl(wUrl.c_str(), 0, 0, &uc))
        throw std::runtime_error("Invalid URL");
    bool https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    HINTERNET hSession = WinHttpOpen(L"QQ/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) throw std::runtime_error("WinHttpOpen failed");
    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0);
    if (!WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0) || !WinHttpReceiveResponse(hRequest, nullptr)) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        throw std::runtime_error("Request failed");
    }
    std::string body;
    DWORD avail, rd;
    while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
        std::string chunk(avail, 0);
        WinHttpReadData(hRequest, chunk.data(), avail, &rd);
        chunk.resize(rd); body += chunk;
    }
    WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
    return json::parse(body);
}

static bool downloadFile(const std::string& url, const std::wstring& dest) {
    auto wUrl = U2W(url);
    URL_COMPONENTS uc{sizeof(uc)};
    wchar_t host[256]{}, path[2048]{};
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2048;
    if (!WinHttpCrackUrl(wUrl.c_str(), 0, 0, &uc)) return false;
    bool https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    HINTERNET hS = WinHttpOpen(L"QQ/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    HINTERNET hC = WinHttpConnect(hS, host, uc.nPort, 0);
    HINTERNET hR = WinHttpOpenRequest(hC, L"GET", path, nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0);
    if (!WinHttpSendRequest(hR, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0) || !WinHttpReceiveResponse(hR, nullptr)) {
        WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS);
        return false;
    }
    std::ofstream out(dest, std::ios::binary);
    DWORD avail, rd;
    while (WinHttpQueryDataAvailable(hR, &avail) && avail > 0) {
        std::string chunk(avail, 0);
        WinHttpReadData(hR, chunk.data(), avail, &rd);
        out.write(chunk.data(), rd);
    }
    WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS);
    return true;
}

static void reg_updater() {
    ipc_on("app.checkUpdate", [](const json& a) -> json {
        auto url = a.value("url", std::string{});
        if (url.empty()) throw std::runtime_error("url is required");
        return httpGet(url);
    });
    ipc_on("app.downloadUpdate", [](const json& a) -> json {
        auto url = a.value("url", std::string{});
        if (url.empty()) throw std::runtime_error("url is required");
        auto dest = app_data_dir() + L"\\update.exe";
        if (!downloadFile(url, dest)) throw std::runtime_error("Download failed");
        return W2U(dest);
    });
    ipc_on("app.installUpdate", [](const json&) -> json {
        auto updateExe = app_data_dir() + L"\\update.exe";
        if (!fspath::exists(updateExe))
            throw std::runtime_error("No update downloaded");
        auto currentExe = exe_path();
        auto oldExe = currentExe + L".old";
        // Create a batch script to replace and restart
        auto bat = app_data_dir() + L"\\update.bat";
        std::ofstream f(bat);
        f << "@echo off\n";
        f << "timeout /t 1 /nobreak >nul\n";
        f << "del \"" << W2U(oldExe) << "\" 2>nul\n";
        f << "move \"" << W2U(currentExe) << "\" \"" << W2U(oldExe) << "\"\n";
        f << "move \"" << W2U(updateExe) << "\" \"" << W2U(currentExe) << "\"\n";
        f << "start \"\" \"" << W2U(currentExe) << "\"\n";
        f << "del \"%~f0\"\n";
        f.close();
        ShellExecuteW(nullptr, L"open", bat.c_str(), nullptr, nullptr, SW_HIDE);
        PostQuitMessage(0);
        return true;
    });
}

// ================================================================
//  Commands: Multi-window
// ================================================================

static LRESULT CALLBACK ChildWndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_SIZE) {
        for (auto& [id, cw] : g_children) {
            if (cw->hwnd == h && cw->ctrl) {
                RECT b; GetClientRect(h, &b);
                cw->ctrl->put_Bounds(b);
                break;
            }
        }
        return 0;
    }
    if (m == WM_CLOSE) {
        for (auto& [id, cw] : g_children) {
            if (cw->hwnd == h) {
                ipc_emit("window.childClosed", {{"id", id}});
                break;
            }
        }
        DestroyWindow(h);
        return 0;
    }
    if (m == WM_DESTROY) {
        for (auto it = g_children.begin(); it != g_children.end(); ++it) {
            if (it->second->hwnd == h) {
                delete it->second;
                g_children.erase(it);
                break;
            }
        }
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void reg_multiwindow() {
    static bool classRegistered = false;

    ipc_on("window.createChild", [](const json& a) -> json {
        auto title = U2W(a.value("title", std::string{""}));
        int w = a.value("width", 600), h = a.value("height", 400);
        auto url = a.value("url", std::string{});

        if (!classRegistered) {
            WNDCLASSEXW wc{sizeof(wc)};
            wc.lpfnWndProc = ChildWndProc;
            wc.hInstance = GetModuleHandleW(nullptr);
            wc.lpszClassName = L"MeshScope3D.Child";
            wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            wc.hbrBackground = g_bgBrush ? g_bgBrush : (HBRUSH)(COLOR_WINDOW + 1);
            RegisterClassExW(&wc);
            classRegistered = true;
        }

        int id = g_nextChildId++;
        HWND child = CreateWindowExW(0, L"MeshScope3D.Child", title.c_str(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT, CW_USEDEFAULT, w, h,
            g_hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
        ShowWindow(child, SW_SHOW);

        auto* cw = new ChildWindow{id, child, nullptr, nullptr};
        g_children[id] = cw;

        // Create WebView2 in child window (windowed mode for simplicity)
        g_env->CreateCoreWebView2Controller(child,
            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [id, url](HRESULT hr, ICoreWebView2Controller* ctrl) -> HRESULT {
                auto it = g_children.find(id);
                if (FAILED(hr) || it == g_children.end()) return hr;
                auto* cw = it->second;
                cw->ctrl = ctrl;
                ctrl->get_CoreWebView2(&cw->view);
                RECT b; GetClientRect(cw->hwnd, &b);
                ctrl->put_Bounds(b);

                // Navigate
                if (!url.empty()) {
                    cw->view->Navigate(U2W(url).c_str());
                } else {
                    cw->view->Navigate(L"http://app.localhost/index.html");
                }
                return S_OK;
            }).Get());

        return id;
    });

    ipc_on("window.closeChild", [](const json& a) -> json {
        int id = a.value("id", 0);
        auto it = g_children.find(id);
        if (it == g_children.end()) return false;
        PostMessageW(it->second->hwnd, WM_CLOSE, 0, 0);
        return true;
    });

    ipc_on("window.listChildren", [](const json&) -> json {
        json arr = json::array();
        for (auto& [id, cw] : g_children)
            arr.push_back(id);
        return arr;
    });
}

// ================================================================
//  Commands: System theme + Taskbar + Shell.run + Opacity
// ================================================================

static void reg_extras() {
    // System theme detection
    ipc_on("os.isDarkMode", [](const json&) -> json {
        HKEY hKey;
        if (RegOpenKeyExW(HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            0, KEY_READ, &hKey) != ERROR_SUCCESS) return false;
        DWORD val = 1, sz = sizeof(val);
        RegQueryValueExW(hKey, L"AppsUseLightTheme", nullptr, nullptr, (BYTE*)&val, &sz);
        RegCloseKey(hKey);
        return val == 0; // 0 = dark mode
    });

    // Window opacity
    ipc_on("window.setOpacity", [](const json& a) -> json {
        double opacity = a.value("opacity", 1.0);
        BYTE alpha = (BYTE)(opacity * 255);
        auto style = GetWindowLongW(g_hwnd, GWL_EXSTYLE);
        if (alpha < 255) {
            SetWindowLongW(g_hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
            SetLayeredWindowAttributes(g_hwnd, 0, alpha, LWA_ALPHA);
        } else {
            SetWindowLongW(g_hwnd, GWL_EXSTYLE, style & ~WS_EX_LAYERED);
        }
        return true;
    });

    // Taskbar progress
    ipc_on("window.setProgress", [](const json& a) -> json {
        double value = a.value("value", -1.0); // -1 = hide, 0..1 = progress
        ComPtr<ITaskbarList3> taskbar;
        if (FAILED(CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_ALL,
            IID_PPV_ARGS(&taskbar)))) return false;
        taskbar->HrInit();
        if (value < 0) {
            taskbar->SetProgressState(g_hwnd, TBPF_NOPROGRESS);
        } else {
            taskbar->SetProgressState(g_hwnd, TBPF_NORMAL);
            taskbar->SetProgressValue(g_hwnd, (ULONGLONG)(value * 1000), 1000);
        }
        return true;
    });

    // Shell.run with stdout/stderr capture
    ipc_on("shell.run", [](const json& a) -> json {
        auto program = a.value("program", std::string{});
        if (program.empty()) throw std::runtime_error("program is required");
        std::wstring cmdLine = U2W(program);
        if (a.contains("args") && a["args"].is_array()) {
            for (auto& arg : a["args"]) {
                auto s = U2W(arg.get<std::string>());
                cmdLine += L" ";
                if (s.find(L' ') != std::wstring::npos)
                    cmdLine += L'"' + s + L'"';
                else
                    cmdLine += s;
            }
        }

        SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
        HANDLE hOutR, hOutW, hErrR, hErrW;
        CreatePipe(&hOutR, &hOutW, &sa, 0);
        CreatePipe(&hErrR, &hErrW, &sa, 0);
        SetHandleInformation(hOutR, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(hErrR, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{sizeof(si)};
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = hOutW;
        si.hStdError = hErrW;
        PROCESS_INFORMATION pi{};

        std::vector<wchar_t> cmd(cmdLine.begin(), cmdLine.end());
        cmd.push_back(0);
        if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            CloseHandle(hOutR); CloseHandle(hOutW);
            CloseHandle(hErrR); CloseHandle(hErrW);
            throw std::runtime_error("Failed to start process");
        }
        CloseHandle(hOutW);
        CloseHandle(hErrW);

        auto readPipe = [](HANDLE h) -> std::string {
            std::string result;
            char buf[4096];
            DWORD rd;
            while (ReadFile(h, buf, sizeof(buf), &rd, nullptr) && rd > 0)
                result.append(buf, rd);
            CloseHandle(h);
            return result;
        };

        // Read stderr in a background thread to prevent pipe deadlock
        struct PipeCtx { HANDLE h; std::string data; };
        auto* errCtx = new PipeCtx{hErrR, {}};
        HANDLE hErrThread = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
            auto* c = (PipeCtx*)p;
            char buf[4096]; DWORD rd;
            while (ReadFile(c->h, buf, sizeof(buf), &rd, nullptr) && rd > 0)
                c->data.append(buf, rd);
            CloseHandle(c->h);
            return 0;
        }, errCtx, 0, nullptr);
        auto stdout_ = readPipe(hOutR);
        WaitForSingleObject(hErrThread, INFINITE);
        CloseHandle(hErrThread);
        auto stderr_ = std::move(errCtx->data);
        delete errCtx;
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD exitCode;
        GetExitCodeProcess(pi.hProcess, &exitCode);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);

        return json{{"exitCode", (int)exitCode}, {"stdout", stdout_}, {"stderr", stderr_}};
    });
}

// ================================================================
//  Splash screen
// ================================================================

static LRESULT CALLBACK SplashProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_PAINT) {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(h, &ps);
        RECT rc; GetClientRect(h, &rc);
        // Background
        auto bg = g_cfg.value("/window/backgroundColor"_json_pointer, std::string{"#1a1a2e"});
        int r=26,g=26,b=46;
        if (bg.size()>=7) { r=std::stoi(bg.substr(1,2),0,16); g=std::stoi(bg.substr(3,2),0,16); b=std::stoi(bg.substr(5,2),0,16); }
        HBRUSH brush = CreateSolidBrush(RGB(r,g,b));
        FillRect(hdc, &rc, brush);
        DeleteObject(brush);
        // Title text
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, RGB(200,200,200));
        auto title = U2W(g_cfg.value("/window/title"_json_pointer, std::string{"\xe5\xbc\xba\xe5\xbc\xba"}));
        HFONT hFont = CreateFontW(28, 0, 0, 0, FW_LIGHT, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        auto old = SelectObject(hdc, hFont);
        DrawTextW(hdc, title.c_str(), -1, &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        // "Loading..." below
        RECT rc2 = rc; rc2.top += 40;
        HFONT hSmall = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        SelectObject(hdc, hSmall);
        SetTextColor(hdc, RGB(120,120,140));
        DrawTextW(hdc, L"Loading...", -1, &rc2, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(hdc, old);
        DeleteObject(hFont);
        DeleteObject(hSmall);
        EndPaint(h, &ps);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static void showSplash(HINSTANCE hi, int w, int h) {
    if (!g_cfg.value("/window/splash"_json_pointer, false)) return;
    WNDCLASSEXW sc{sizeof(sc)};
    sc.lpfnWndProc  = SplashProc;
    sc.hInstance     = hi;
    sc.lpszClassName = L"MeshScope3D.Splash";
    sc.hCursor       = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassExW(&sc);

    HMONITOR mon = MonitorFromPoint({0,0}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(mon, &mi);
    int sw = 300, sh = 120;
    int sx = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - sw) / 2;
    int sy = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - sh) / 2;

    g_splash = CreateWindowExW(WS_EX_TOOLWINDOW, L"MeshScope3D.Splash", L"",
        WS_POPUP, sx, sy, sw, sh, nullptr, nullptr, hi, nullptr);
    // DWM shadow
    MARGINS m = {0,0,0,1};
    DwmExtendFrameIntoClientArea(g_splash, &m);
    ShowWindow(g_splash, SW_SHOW);
    UpdateWindow(g_splash);
}

static void closeSplash() {
    if (g_splash) {
        DestroyWindow(g_splash);
        g_splash = nullptr;
    }
}

// ================================================================
//  WebView2 initialization
// ================================================================

static void setupWebView(ICoreWebView2Controller* ctrl) {
    g_ctrl = ctrl;
    g_ctrl->get_CoreWebView2(&g_view);

    RECT b; GetClientRect(g_hwnd, &b);
    g_ctrl->put_Bounds(b);

    // Background color from config (alpha=255 for opaque)
    ComPtr<ICoreWebView2Controller2> ctrl2;
    if (SUCCEEDED(g_ctrl.As(&ctrl2))) {
        auto hex = g_cfg.value("/window/backgroundColor"_json_pointer, std::string{"#1a1a2e"});
        auto clr = parseHexColor(hex);
        BYTE alpha = (g_effectType >= 2) ? 0 : 255;
        ctrl2->put_DefaultBackgroundColor({alpha, GetRValue(clr), GetGValue(clr), GetBValue(clr)});
    }

    // Wails: use raw pixels mode for better resize performance
    ComPtr<ICoreWebView2Controller3> ctrl3;
    if (SUCCEEDED(g_ctrl.As(&ctrl3))) {
        ctrl3->put_BoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
        ctrl3->put_ShouldDetectMonitorScaleChanges(FALSE);
        UINT dpi = GetDpiForWindow(g_hwnd);
        ctrl3->put_RasterizationScale(dpi / 96.0);
    }

    // Settings
    ComPtr<ICoreWebView2Settings> s;
    g_view->get_Settings(&s);
    s->put_IsScriptEnabled(TRUE);
    s->put_AreDefaultScriptDialogsEnabled(TRUE);
    s->put_IsWebMessageEnabled(TRUE);
    bool dev = !g_devUrl.empty();
    s->put_AreDevToolsEnabled(dev ? TRUE : FALSE);
    s->put_AreDefaultContextMenusEnabled(dev ? TRUE : FALSE);
    s->put_IsStatusBarEnabled(FALSE);

    // Wails-aligned: disable browser shortcuts (Ctrl+P, Ctrl+S, etc.)
    ComPtr<ICoreWebView2Settings3> s3;
    if (SUCCEEDED(s.As(&s3)))
        s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);

    // Disable swipe navigation (prevents accidental back/forward on touchpad)
    ComPtr<ICoreWebView2Settings6> s6;
    if (SUCCEEDED(s.As(&s6)))
        s6->put_IsSwipeNavigationEnabled(FALSE);

    // Disable pinch zoom (desktop apps usually don't need it)
    ComPtr<ICoreWebView2Settings5> s5;
    if (SUCCEEDED(s.As(&s5)))
        s5->put_IsPinchZoomEnabled(FALSE);

    // Enable CSS app-region:drag for declarative title bar drag
    ComPtr<ICoreWebView2Settings9> s9;
    if (SUCCEEDED(s.As(&s9)))
        s9->put_IsNonClientRegionSupportEnabled(TRUE);

    // Auto-allow permissions (camera, microphone, etc.) without prompts
    g_view->add_PermissionRequested(
        Callback<ICoreWebView2PermissionRequestedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
            return S_OK;
        }).Get(), nullptr);

    // Process crash recovery
    g_view->add_ProcessFailed(
        Callback<ICoreWebView2ProcessFailedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_PROCESS_FAILED_KIND kind;
            args->get_ProcessFailedKind(&kind);
            if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
                MessageBoxW(g_hwnd, L"WebView2 进程已崩溃，应用将关闭。", L"错误", MB_ICONERROR);
                PostQuitMessage(1);
            }
            return S_OK;
        }).Get(), nullptr);

    // IPC handler
    g_view->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
            LPWSTR m; a->get_WebMessageAsJson(&m);
            ipc_dispatch(m);
            CoTaskMemFree(m);
            return S_OK;
        }).Get(), nullptr);

    // Navigate
#ifdef SINGLE_EXE
    if (dev || g_pakEntries.empty()) register_local_file_resource_handler();
#else
    register_local_file_resource_handler();
#endif
    if (dev) {
        g_view->Navigate(g_devUrl.c_str());
    } else {
#ifdef SINGLE_EXE
        if (!g_pakEntries.empty()) {
            // Serve resources directly from memory — zero disk I/O
            g_view->AddWebResourceRequestedFilter(
                L"http://app.localhost/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
            g_view->add_WebResourceRequested(
                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    auto respondText = [&](int status, const wchar_t* reason, const char* body) -> HRESULT {
                        const auto len = static_cast<UINT>(strlen(body));
                        ComPtr<IStream> stream;
                        stream.Attach(SHCreateMemStream(
                            reinterpret_cast<const BYTE*>(body),
                            len));
                        if (!stream) return S_OK;

                        ComPtr<ICoreWebView2WebResourceResponse> response;
                        g_env->CreateWebResourceResponse(
                            stream.Get(), status, reason,
                            L"Content-Type: text/plain; charset=utf-8",
                            &response);
                        args->put_Response(response.Get());
                        return S_OK;
                    };

                    ComPtr<ICoreWebView2WebResourceRequest> request;
                    args->get_Request(&request);
                    LPWSTR uri;
                    request->get_Uri(&uri);
                    std::wstring wUri(uri);
                    CoTaskMemFree(uri);

                    const std::wstring prefix = L"http://app.localhost/";
                    std::string path;
                    if (wUri.size() > prefix.size())
                        path = W2U(wUri.substr(prefix.size()));
                    // Strip query string and fragment
                    auto qpos = path.find('?');
                    if (qpos != std::string::npos) path = path.substr(0, qpos);
                    auto hpos = path.find('#');
                    if (hpos != std::string::npos) path = path.substr(0, hpos);
                    path = percent_decode_path(path);
                    std::string localToken;
                    if (extract_local_file_token_from_path(path, localToken)) {
                        return respond_local_file_resource(args, localToken);
                    }
                    if (path.empty()) path = "index.html";
                    if (!is_safe_pak_path(path)) return respondText(404, L"Not Found", "Not Found");

                    auto* entry = findPakEntry(path);
                    if (!entry) return respondText(404, L"Not Found", "Not Found");

                    auto mime = guessMimeType(path);
                    ComPtr<IStream> stream;
                    stream.Attach(SHCreateMemStream(
                        reinterpret_cast<const BYTE*>(entry->data), entry->size));
                    if (!stream) return S_OK;

                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    g_env->CreateWebResourceResponse(
                        stream.Get(), 200, L"OK",
                        (L"Content-Type: " + mime).c_str(),
                        &response);
                    args->put_Response(response.Get());
                    return S_OK;
                }).Get(), nullptr);

            g_view->Navigate(L"http://app.localhost/index.html");
        } else
#endif
        {
            auto dir = exe_dir();
            ComPtr<ICoreWebView2_3> v3;
            if (SUCCEEDED(g_view.As(&v3)))
                v3->SetVirtualHostNameToFolderMapping(
                    L"app.localhost", dir.c_str(),
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
            g_view->Navigate(L"https://app.localhost/index.html");
        }
    }
    g_view->add_NavigationCompleted(
        Callback<ICoreWebView2NavigationCompletedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
            // Wails hack: Hide+Show WebView2 controller to force render
            // https://github.com/MicrosoftEdge/WebView2Feedback/issues/1077
            g_ctrl->put_IsVisible(FALSE);
            g_ctrl->put_IsVisible(TRUE);
            g_webviewReady = true;
            closeSplash();
            return S_OK;
        }).Get(), nullptr);
}

static void init_webview() {
    auto dataDir = app_data_dir();
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    options->put_AdditionalBrowserArguments(
        L"--disable-features=msSmartScreenProtection,RendererCodeIntegrity,msWebOOUI,msPdfOOUI"
        L" --disable-background-networking --no-proxy-server");
    CreateCoreWebView2EnvironmentWithOptions(nullptr, dataDir.c_str(), options.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
        [](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
            if (FAILED(hr)) {
                MessageBoxW(g_hwnd,
                    L"WebView2 \u521D\u59CB\u5316\u5931\u8D25\u3002\n\u8BF7\u5B89\u88C5 WebView2 Runtime:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    L"\u9519\u8BEF", MB_ICONERROR);
                PostQuitMessage(1);
                return hr;
            }
            g_env = env;
            // Try to use ControllerOptions with pre-set background color (avoids white flash)
            ComPtr<ICoreWebView2Environment10> env10;
            auto handler = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                [](HRESULT hr, ICoreWebView2Controller* ctrl) -> HRESULT {
                    if (FAILED(hr)) { PostQuitMessage(1); return hr; }
                    setupWebView(ctrl);
                    return S_OK;
                });
            if (SUCCEEDED(env->QueryInterface(IID_PPV_ARGS(&env10)))) {
                ComPtr<ICoreWebView2ControllerOptions> opts;
                if (SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&opts))) {
                    ComPtr<ICoreWebView2ControllerOptions3> opts3;
                    if (SUCCEEDED(opts.As(&opts3))) {
                        auto hex = g_cfg.value("/window/backgroundColor"_json_pointer, std::string{"#1a1a2e"});
                        auto clr = parseHexColor(hex);
                        BYTE alpha = (g_effectType >= 2) ? 0 : 255;
                        opts3->put_DefaultBackgroundColor({alpha, GetRValue(clr), GetGValue(clr), GetBValue(clr)});
                    }
                    return env10->CreateCoreWebView2ControllerWithOptions(g_hwnd, opts.Get(), handler.Get());
                }
            }
            return g_env->CreateCoreWebView2Controller(g_hwnd, handler.Get());
        }).Get());
}

// ================================================================
//  Window procedure
// ================================================================

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    // ── Fill background (visible briefly before WebView2 content loads) ──
    case WM_NCPAINT:
        if (g_frameless) return 0;
        break;
    case WM_NCACTIVATE:
        if (g_frameless) return TRUE; // prevents DefWindowProc from repainting NC area
        break;
    case WM_ERASEBKGND:
        if (g_frameless && g_bgBrush) {
            HDC hdc = (HDC)w;
            RECT rc;
            GetClientRect(h, &rc);
            FillRect(hdc, &rc, g_bgBrush);
            return 1;
        }
        break;
    case WM_PAINT:
        if (g_frameless && g_bgBrush) {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(h, &ps);
            FillRect(hdc, &ps.rcPaint, g_bgBrush);
            EndPaint(h, &ps);
            return 0;
        }
        break;

    case WM_COPYDATA: {
        auto* data = reinterpret_cast<COPYDATASTRUCT*>(l);
        if (data
            && (data->dwData == kOpenFilesCopyData || data->dwData == kOpenUrlsCopyData)
            && data->lpData) {
            auto items = parse_copydata_payload(data);
            if (data->dwData == kOpenFilesCopyData) {
                if (g_frontendReady) emit_open_files(items);
                else g_pendingLaunchFiles.insert(g_pendingLaunchFiles.end(), items.begin(), items.end());
            } else {
                if (g_frontendReady) emit_open_urls(items);
                else g_pendingLaunchUrls.insert(g_pendingLaunchUrls.end(), items.begin(), items.end());
            }

            restore_and_focus_window(h);
            return TRUE;
        }
        break;
    }

    case WM_SIZE:
        if (g_ctrl) {
            RECT b; GetClientRect(h, &b);
            g_ctrl->put_Bounds(b);
        }
        if (w == SIZE_MAXIMIZED)      ipc_emit("window.maximized");
        else if (w == SIZE_MINIMIZED) ipc_emit("window.minimized");
        else if (w == SIZE_RESTORED)  ipc_emit("window.restored");
        ipc_emit("window.resized", {{"w", (int)LOWORD(l)}, {"h", (int)HIWORD(l)}});
        return 0;

    case WM_DPICHANGED:
        if (l) {
            auto* r = reinterpret_cast<RECT*>(l);
            SetWindowPos(
                h,
                nullptr,
                r->left,
                r->top,
                r->right - r->left,
                r->bottom - r->top,
                SWP_NOZORDER | SWP_NOACTIVATE
            );
        }
        if (g_ctrl) {
            ComPtr<ICoreWebView2Controller3> ctrl3;
            if (SUCCEEDED(g_ctrl.As(&ctrl3)))
                ctrl3->put_RasterizationScale(HIWORD(w) / 96.0);
        }
        return 0;

    case WM_MOVE:
    case WM_MOVING:
        // Wails: notify WebView2 of position changes (fixes popup positioning)
        if (g_ctrl) {
            ComPtr<ICoreWebView2Controller3> ctrl3;
            if (SUCCEEDED(g_ctrl.As(&ctrl3)))
                ctrl3->NotifyParentWindowPositionChanged();
        }
        if (m == WM_MOVE)
            ipc_emit("window.moved", {{"x", (int)(short)LOWORD(l)}, {"y", (int)(short)HIWORD(l)}});
        return 0;

    case WM_SETTINGCHANGE:
        if (l) {
            auto setting = W2U((LPCWSTR)l);
            if (setting == "ImmersiveColorSet") {
                HKEY hKey; DWORD val = 1, sz = sizeof(val);
                if (RegOpenKeyExW(HKEY_CURRENT_USER,
                    L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                    0, KEY_READ, &hKey) == ERROR_SUCCESS) {
                    RegQueryValueExW(hKey, L"AppsUseLightTheme", nullptr, nullptr, (BYTE*)&val, &sz);
                    RegCloseKey(hKey);
                }
                ipc_emit("os.themeChanged", {{"dark", val == 0}});
            }
        }
        return 0;
    case WM_SETFOCUS:
        if (g_ctrl) g_ctrl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        ipc_emit("window.focus");
        return 0;
    case WM_KILLFOCUS:
        ipc_emit("window.blur");
        return 0;
    case WM_CLOSE:
        saveWindowState();
        ipc_emit("window.closing");
        if (g_trayActive) { ShowWindow(h, SW_HIDE); return 0; }
        DestroyWindow(h);
        return 0;
    case WM_DESTROY:
        // Cleanup watchers
        for (auto& [id, w] : g_watchers) {
            w->active = false;
            CancelIoEx(w->hDir, nullptr);
            WaitForSingleObject(w->hThread, 500);
            CloseHandle(w->hThread);
            CloseHandle(w->hDir);
            delete w;
        }
        g_watchers.clear();
        if (g_trayActive) Shell_NotifyIconW(NIM_DELETE, &g_nid);
        PostQuitMessage(0);
        return 0;
    case WM_HOTKEY:
        ipc_emit("hotkey.triggered", {{"id", (int)w}});
        return 0;
    case WM_FILE_CHANGED: {
        auto* data = reinterpret_cast<json*>(l);
        ipc_emit("watcher.changed", *data);
        delete data;
        return 0;
    }
    case WM_KEYDOWN:
        // F12 toggles DevTools in dev mode
        if (w == VK_F12 && !g_devUrl.empty()) {
            if (g_view) g_view->OpenDevToolsWindow();
            return 0;
        }
        break;
    case WM_DROPFILES: {
        HDROP hDrop = (HDROP)w;
        UINT count = DragQueryFileW(hDrop, 0xFFFFFFFF, nullptr, 0);
        json files = json::array();
        for (UINT i = 0; i < count; i++) {
            UINT len = DragQueryFileW(hDrop, i, nullptr, 0);
            std::wstring path(len + 1, L'\0');
            DragQueryFileW(hDrop, i, path.data(), len + 1);
            path.resize(len);
            files.push_back(W2U(path));
        }
        POINT pt;
        DragQueryPoint(hDrop, &pt);
        DragFinish(hDrop);
        ipc_emit("window.fileDrop", {{"files", files}, {"x", pt.x}, {"y", pt.y}});
        return 0;
    }
    case WM_TRAYICON:
        switch (LOWORD(l)) {
        case WM_LBUTTONUP:    ipc_emit("tray.click"); break;
        case WM_LBUTTONDBLCLK:
            restore_and_focus_window(g_hwnd);
            ipc_emit("tray.doubleClick");
            break;
        case WM_RBUTTONUP:    ipc_emit("tray.rightClick"); break;
        }
        return 0;

    // ── Frameless window handling ──
    case WM_NCCALCSIZE:
        if (g_frameless && w) {
            auto* p = reinterpret_cast<NCCALCSIZE_PARAMS*>(l);
            // When maximized, respect taskbar area
            WINDOWPLACEMENT wpl{sizeof(wpl)};
            GetWindowPlacement(h, &wpl);
            if (wpl.showCmd == SW_MAXIMIZE) {
                HMONITOR mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
                MONITORINFO mi{sizeof(mi)};
                GetMonitorInfoW(mon, &mi);
                p->rgrc[0] = mi.rcWork;
            }
            return 0;
        }
        break;

    case WM_GETMINMAXINFO: {
        auto mw = g_cfg.value("/window/minWidth"_json_pointer, 200);
        auto mh = g_cfg.value("/window/minHeight"_json_pointer, 150);
        auto* mmi = reinterpret_cast<MINMAXINFO*>(l);
        mmi->ptMinTrackSize = { mw, mh };
        if (g_frameless) {
            HMONITOR mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            MONITORINFO mi{sizeof(mi)};
            if (GetMonitorInfoW(mon, &mi)) {
                mmi->ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
                mmi->ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
                mmi->ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
                mmi->ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
                mmi->ptMaxTrackSize = mmi->ptMaxSize;
            }
        }
        return 0;
    }
    }
    return DefWindowProcW(h, m, w, l);
}

// ================================================================
//  Entry point
// ================================================================

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, LPWSTR, int ns) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    // Parse command line
    int argc;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--dev") == 0 && i + 1 < argc) {
            g_devUrl = argv[++i];
            continue;
        }
        if (wcscmp(argv[i], L"--protocol") == 0 && i + 1 < argc) {
            g_pendingLaunchUrls.push_back(argv[++i]);
            continue;
        }
        if (argv[i][0] == L'-') continue;
        try {
            auto path = normalize_path(argv[i]);
            if (fspath::exists(path) && !fspath::is_directory(path)) {
                g_pendingLaunchFiles.push_back(path);
                continue;
            }
        } catch (...) {}
        if (has_url_scheme(argv[i])) {
            g_pendingLaunchUrls.push_back(argv[i]);
            continue;
        }
    }
    LocalFree(argv);

    // Load config
    g_cfg = loadConfig(exe_dir());
#ifdef SINGLE_EXE
    loadPak();
#endif
    auto winCfg    = g_cfg.value("window", json::object());
    auto title     = U2W(winCfg.value("title", std::string{"\xe5\xbc\xba\xe5\xbc\xba"}));
    g_resizable    = winCfg.value("resizable", true);
    g_windowClassName = std::wstring(L"MeshScope3D.Window.") + instance_identity_suffix();
    SetCurrentProcessExplicitAppUserModelID(kAppUserModelId);

    // Single instance lock
    bool singleInstance = winCfg.value("singleInstance", true);
    HANDLE hMutex = nullptr;
    if (singleInstance) {
        const auto mutexName = instance_mutex_name();
        hMutex = CreateMutexW(nullptr, FALSE, mutexName.c_str());
        if (hMutex && GetLastError() == ERROR_ALREADY_EXISTS) {
            HWND existing = nullptr;
            for (int attempt = 0; attempt < 30 && !existing; ++attempt) {
                existing = FindWindowW(g_windowClassName.c_str(), nullptr);
                if (!existing) Sleep(100);
            }
            if (existing) {
                DWORD existingPid = 0;
                GetWindowThreadProcessId(existing, &existingPid);
                if (existingPid) AllowSetForegroundWindow(existingPid);
                if (!g_pendingLaunchFiles.empty()) {
                    send_copydata_payload(existing, kOpenFilesCopyData, g_pendingLaunchFiles);
                }
                if (!g_pendingLaunchUrls.empty()) {
                    send_copydata_payload(existing, kOpenUrlsCopyData, g_pendingLaunchUrls);
                }
                restore_and_focus_window(existing);
            }
            if (hMutex) CloseHandle(hMutex);
            CoUninitialize();
            return 0;
        }
    }
    int  width     = winCfg.value("width", 1024);
    int  height    = winCfg.value("height", 768);
    g_frameless    = winCfg.value("frameless", false);
    g_effectType   = parseEffectType(winCfg.value("effect", std::string{"none"}));

    // Security: load permissions
    if (g_cfg.contains("permissions") && g_cfg["permissions"].is_object()) {
        for (auto& [k, v] : g_cfg["permissions"].items()) {
            g_permissions[k] = v.get<bool>();
        }
    }

    auto bgHex     = winCfg.value("backgroundColor", std::string{"#1a1a2e"});
    COLORREF bgClr = parseHexColor(bgHex);

    // Window class
    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc   = WndProc;
    wc.hInstance      = hi;
    wc.lpszClassName  = g_windowClassName.c_str();
    wc.hCursor        = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground  = CreateSolidBrush(bgClr);
    // Try custom icon from resource, fallback to default
    wc.hIcon   = LoadIconW(hi, MAKEINTRESOURCE(IDI_APP));
    wc.hIconSm = LoadIconW(hi, MAKEINTRESOURCE(IDI_APP));
    if (!wc.hIcon) {
        wc.hIcon   = LoadIconW(nullptr, IDI_APPLICATION);
        wc.hIconSm = LoadIconW(nullptr, IDI_APPLICATION);
    }
    RegisterClassExW(&wc);

    DWORD style = g_frameless
        ? (WS_MINIMIZEBOX | WS_SYSMENU | WS_POPUP | WS_CLIPCHILDREN)
        : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN);
    if (g_resizable) {
        style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
    }

    DWORD exStyle = WS_EX_APPWINDOW;
    if (winCfg.value("alwaysOnTop", false)) exStyle |= WS_EX_TOPMOST;
    g_hwnd = CreateWindowExW(exStyle, g_windowClassName.c_str(), title.c_str(),
        style,
        CW_USEDEFAULT, CW_USEDEFAULT, width, height,
        nullptr, nullptr, hi, nullptr);

    // Window state persistence — restore previous position/size
    g_stateFile = app_data_dir() + L"\\window-state.json";
    auto prevState = loadWindowState();
    if (!prevState.empty()) {
        int sx = prevState.value("x", 0);
        int sy = prevState.value("y", 0);
        int sw = prevState.value("w", width);
        int sh = prevState.value("h", height);
        auto minW = g_cfg.value("/window/minWidth"_json_pointer, 200);
        auto minH = g_cfg.value("/window/minHeight"_json_pointer, 150);
        RECT restored{sx, sy, sx + sw, sy + sh};
        restored = clampWindowRectToWorkArea(restored, minW, minH);
        SetWindowPos(
            g_hwnd,
            nullptr,
            restored.left,
            restored.top,
            restored.right - restored.left,
            restored.bottom - restored.top,
            SWP_NOZORDER
        );
        if (prevState.value("maximized", false))
            ns = SW_MAXIMIZE;
    }

    // DWM attributes for frameless
    if (g_frameless) {
        g_bgClr = bgClr;
        applyFramelessDwmAttrs();
        g_bgBrush = CreateSolidBrush(bgClr);
    }

    // Enable file drag-drop
    DragAcceptFiles(g_hwnd, TRUE);

    // Register all commands
    reg_window();
    reg_dialog();
    reg_fs();
    reg_clipboard();
    reg_shell_app();
    reg_tray();
    reg_env();
    reg_hotkey();
    reg_notification();
    reg_menu();
    reg_http();
    reg_os();
    reg_watcher();
    reg_state();
    reg_devtools();
    reg_registry();
    reg_protocol();
    reg_log();
    reg_updater();
    reg_multiwindow();
    reg_extras();

    // Show window immediately with background color (don't wait for WebView2)
    ShowWindow(g_hwnd, ns);
    UpdateWindow(g_hwnd);

    init_webview();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (hMutex) CloseHandle(hMutex);
    CoUninitialize();
    return (int)msg.wParam;
}
