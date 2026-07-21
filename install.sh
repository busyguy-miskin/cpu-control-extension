#!/usr/bin/env bash
# ============================================================
# CPU 控制 GNOME 扩展 — 统一安装脚本
#
# 一键安装:
#   - GNOME 扩展(用户级)
#   - root helper cpuctrl + polkit 策略(系统级)
#   - ryzenadj 调优守护进程 + 配置 + systemd unit(系统级)
#
# 用法:
#   bash install.sh            # 安装
#   bash install.sh --uninstall  # 卸载
# ============================================================
set -euo pipefail

GREEN='\033[1;32m'; YEL='\033[1;33m'; RED='\033[1;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YEL}⚠️  $1${NC}"; }
err()  { echo -e "  ${RED}❌ $1${NC}" >&2; }

# 脚本所在目录(包根目录)
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$PKG_DIR/extension"
SYS_SRC="$PKG_DIR/system"

# ryzenadj 构建产物源(用户家目录下的编译输出, 会加固安装成 root 拥有副本)
RYZENADJ_SRC_CANDIDATES=(
    "$HOME/RyzenAdj/build/ryzenadj"
    "$HOME/.local/bin/ryzenadj"
    "/usr/local/bin/ryzenadj"
)

# 安装目标
EXT_UUID="cpu-control@miskin"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
HELPER_DST="/usr/libexec/cpuctrl"
POLICY_DST="/usr/share/polkit-1/actions/org.miskin.cpuctrl.policy"
TUNE_DAEMON_DST="/usr/libexec/ryzenadj-tune"
TUNE_CONF_DST="/etc/ryzenadj-tune.conf"
TUNE_UNIT_DST="/etc/systemd/system/ryzenadj-tune.service"
BOOST_UNIT_DST="/etc/systemd/system/cpu-boost-lock.service"
RYZENADJ_DST="/usr/local/bin/ryzenadj"
TUNE_SVC="ryzenadj-tune.service"
BOOST_SVC="cpu-boost-lock.service"

echo "==== CPU 控制 GNOME 扩展 (双层: boost 锁 + ryzenadj 调优) ===="
echo

# ---------- 卸载模式 ----------
if [[ "${1:-}" == "--uninstall" ]]; then
    echo "[卸载模式]"
    echo
    echo "[1/8] 移除 GNOME 扩展"
    if [[ -d "$EXT_DST" ]]; then
        gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
        rm -rf "$EXT_DST"
        ok "扩展已移除"
    else
        warn "扩展未安装, 跳过"
    fi

    echo
    echo "[2/8] 停止并移除 ryzenadj 调优 service"
    if systemctl list-unit-files 2>/dev/null | grep -q "$TUNE_SVC"; then
        sudo systemctl disable --now "$TUNE_SVC" 2>/dev/null || true
        ok "service 已停止并禁用"
    else
        warn "service 未安装, 跳过"
    fi

    echo
    echo "[3/8] 停止并移除 boost 锁 service"
    if systemctl list-unit-files 2>/dev/null | grep -q "$BOOST_SVC"; then
        sudo systemctl disable --now "$BOOST_SVC" 2>/dev/null || true
        ok "boost 锁 service 已停止并禁用"
    else
        warn "boost 锁 service 未安装, 跳过"
    fi

    echo
    echo "[4/8] 移除 systemd unit"
    sudo rm -f "$TUNE_UNIT_DST" "$BOOST_UNIT_DST"
    sudo systemctl daemon-reload
    ok "unit 文件已移除"

    echo
    echo "[5/8] 移除守护脚本与配置"
    sudo rm -f "$TUNE_DAEMON_DST"
    # 配置文件保留(用户可能记着参数), 提示手动删
    if [[ -f "$TUNE_CONF_DST" ]]; then
        warn "配置 $TUNE_CONF_DST 已保留 (如需删除: sudo rm $TUNE_CONF_DST)"
    fi
    ok "守护脚本已移除"

    echo
    echo "[6/8] 移除 root helper"
    if [[ -f "$HELPER_DST" ]]; then
        sudo rm -f "$HELPER_DST"
        ok "helper 已移除"
    else
        warn "helper 未安装, 跳过"
    fi

    echo
    echo "[7/8] 移除 polkit 策略"
    if [[ -f "$POLICY_DST" ]]; then
        sudo rm -f "$POLICY_DST"
        ok "polkit 策略已移除"
    else
        warn "polkit 策略未安装, 跳过"
    fi

    # ryzenadj 二进制是共用工具, 默认不删, 避免影响其他用途
    echo
    echo "[8/8] 完成"
    echo
    echo "${GREEN}✅ 卸载完成${NC}"
    echo "  注: ryzenadj 二进制 ($RYZENADJ_DST) 默认保留, 如需删除请手动 sudo rm"
    echo "重启 GNOME Shell 让更改生效: Alt+F2 → r → 回车 (Wayland 需注销重登)"
    exit 0
fi

# ---------- 安装模式 ----------
# 0. 权限自检
if ! sudo -v 2>/dev/null; then
    err "需要 sudo 权限(安装 root helper 和 polkit 策略)"
    exit 1
fi

# 1. 源文件检查
echo "[1/9] 检查源文件"
for f in \
    "$EXT_SRC/metadata.json" \
    "$EXT_SRC/extension.js" \
    "$EXT_SRC/indicator.js" \
    "$EXT_SRC/stylesheet.css" \
    "$SYS_SRC/cpuctrl" \
    "$SYS_SRC/org.miskin.cpuctrl.policy" \
    "$SYS_SRC/ryzenadj-tune" \
    "$SYS_SRC/ryzenadj-tune.service" \
    "$SYS_SRC/ryzenadj-tune.conf" \
    "$SYS_SRC/cpu-boost-lock.service"; do
    [[ -f "$f" ]] || { err "缺少 $f"; exit 1; }
done
ok "源文件齐全"

# 2. 安装 GNOME 扩展(用户级, 不需要 root)
echo
echo "[2/9] 安装 GNOME 扩展 → $EXT_DST"
mkdir -p "$EXT_DST"
cp "$EXT_SRC"/* "$EXT_DST/"
ok "扩展文件已就位"

# 3. 安装 root helper(系统级)
echo
echo "[3/9] 安装 root helper → $HELPER_DST"
sudo install -m 0755 -o root -g root "$SYS_SRC/cpuctrl" "$HELPER_DST"
ok "helper 已安装 (root:root 0755)"

# 4. 安装 polkit 策略(系统级)
echo
echo "[4/9] 安装 polkit 策略 → $POLICY_DST"
sudo install -m 0644 -o root -g root "$SYS_SRC/org.miskin.cpuctrl.policy" "$POLICY_DST"
ok "polkit 策略已安装 (polkit 通过 inotify 自动加载)"

# 5. 加固 ryzenadj 二进制(系统级)
# root 守护进程不能执行用户拥有的二进制(提权隐患), 装成 root 拥有副本。
echo
echo "[5/9] 加固 ryzenadj 二进制 → $RYZENADJ_DST"
RYZENADJ_SRC=""
for cand in "${RYZENADJ_SRC_CANDIDATES[@]}"; do
    if [[ -x "$cand" ]] && [[ ! -L "$cand" || "$(readlink -f "$cand")" == "$(readlink -f "$cand" 2>/dev/null)" ]]; then
        # 解析软链到真实文件
        real=$(readlink -f "$cand")
        if [[ -f "$real" ]]; then
            RYZENADJ_SRC="$real"
            break
        fi
    fi
done
if [[ -n "$RYZENADJ_SRC" ]]; then
    sudo install -m 0755 -o root -g root "$RYZENADJ_SRC" "$RYZENADJ_DST"
    ok "ryzenadj 已安装 (源: $RYZENADJ_SRC → $RYZENADJ_DST, root:root)"
else
    warn "找不到 ryzenadj 二进制, 跳过加固"
    echo "       守护进程会尝试用 PATH 中的 ryzenadj"
    echo "       请先构建 ryzenadj (见 README 依赖安装章节)"
fi

# 6. 安装守护脚本(系统级)
echo
echo "[6/9] 安装 ryzenadj 调优守护脚本 → $TUNE_DAEMON_DST"
sudo install -m 0755 -o root -g root "$SYS_SRC/ryzenadj-tune" "$TUNE_DAEMON_DST"
ok "守护脚本已安装"

# 7. 安装配置文件(系统级, 不覆盖已有改动)
echo
echo "[7/9] 安装调优配置 → $TUNE_CONF_DST"
if [[ -f "$TUNE_CONF_DST" ]]; then
    # 已有则备份, 保留用户改动
    sudo cp -a "$TUNE_CONF_DST" "${TUNE_CONF_DST}.bak.$(date +%Y%m%d%H%M%S)"
    ok "已有配置已备份 (.bak.*), 保留用户改动不覆盖"
else
    sudo install -m 0644 -o root -g root "$SYS_SRC/ryzenadj-tune.conf" "$TUNE_CONF_DST"
    ok "配置已安装 (均衡档: 90°C / 85A / 45W)"
fi

# 8. 安装 systemd unit(调优 + boost 锁) 并启动调优(系统级)
echo
echo "[8/9] 安装 systemd unit 文件"
sudo install -m 0644 -o root -g root "$SYS_SRC/ryzenadj-tune.service" "$TUNE_UNIT_DST"
sudo install -m 0644 -o root -g root "$SYS_SRC/cpu-boost-lock.service" "$BOOST_UNIT_DST"
sudo systemctl daemon-reload
ok "unit 文件已就位 (ryzenadj-tune + cpu-boost-lock)"
# 调优 service: 安装即启动 (用户已选择开启调优)
sudo systemctl enable --now "$TUNE_SVC" 2>/dev/null || true
if systemctl is-active "$TUNE_SVC" >/dev/null 2>&1; then
    ok "$TUNE_SVC 已启动并设为开机自启"
else
    warn "$TUNE_SVC 启动失败 (可能缺 ryzenadj 或 ryzen_smu, 见 journalctl -u $TUNE_SVC)"
fi

# 9. boost 锁状态说明(只安装 unit, 绝不擅自动 boost 状态)
echo
echo "[9/9] boost 锁层就绪"
if systemctl is-enabled "$BOOST_SVC" >/dev/null 2>&1; then
    ok "$BOOST_SVC 已就绪并 enabled (开机自动锁 boost=0)"
else
    ok "$BOOST_SVC 已就绪 (当前 disabled, 开机不会动 boost)"
fi
echo "       boost 锁/解锁随时通过扩展菜单切换, 安装不预设任何状态"

echo
echo "${GREEN}✅ 安装完成${NC}"
echo
echo "下一步: 让扩展生效"
echo "  1. 重启 GNOME Shell: Alt+F2 → 输入 r → 回车"
echo "     (Wayland 用户需注销重新登录)"
echo "  2. 启用扩展: gnome-extensions enable $EXT_UUID"
echo
echo "调优档位在扩展下拉菜单里切换(节能/均衡/性能/关闭)"
echo "卸载: bash install.sh --uninstall"
