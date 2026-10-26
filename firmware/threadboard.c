/* SPDX-License-Identifier: MIT */
#include "fastmath.h"
#define TB_VERSION 4u
#define TB_CMD 0x70u
#define TB_ALL_KEYS ((1u << NKEYS) - 1u)
#define TB_THREAD_KEYS 0x05ad5ad5u
enum { TB_EMPTY, TB_IDLE, TB_WORKING, TB_ATTENTION, TB_UNAVAILABLE };
enum { TB_BEGIN, TB_SLOT, TB_COMMIT, TB_ACK, TB_ACTION, TB_HELLO, TB_QUESTION, TB_RESULT };
enum { TB_SELECT, TB_NEXT, TB_STOP, TB_SETTLE, TB_SCROLL, TB_CHOOSE, TB_CONFIRM, TB_QSTEP, TB_QPAGE };
typedef struct { uint32_t token; uint8_t flags,index,total,page,pages,answered; char header[31],text[241]; } tb_question_t;
static tb_question_t tb_question, tb_stage_question;
static uint8_t tb_question_received;
static char tb_result[1201], tb_stage_result[1201];
static uint16_t tb_result_size, tb_result_at;
static uint8_t tb_result_received;
typedef struct {
    uint32_t token, attention_serial;
    uint8_t state;
    char project[31], title[81], detail[145];
} tb_slot_t;
static tb_slot_t tb_slots[NKEYS], tb_stage[NKEYS];
static uint32_t tb_session, tb_revision, tb_stage_session, tb_stage_revision, tb_mask;
static uint32_t tb_heard, tb_hello_at, tb_keys, tb_buttons, tb_bright, tb_dim, tb_mid;
static uint16_t tb_sequence, tb_pending_seq, tb_overflow;
static uint8_t tb_selected, tb_connected, tb_have_snapshot, tb_staging, tb_redraw, tb_help;
static uint8_t tb_pending[16], tb_pending_on, tb_retries, tb_last_action;
static uint32_t tb_pending_at, tb_last_token;
static int32_t tb_scroll;
static char tb_message[64];
static uint32_t tb_message_at;
static volatile uint32_t tb_chime_requested;
static uint32_t tb_chime_seen, tb_chime_frame;
static float tb_chime_phase;

static uint32_t tb_rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void tb_wr32(uint8_t *p, uint32_t n)
{
    p[0] = (uint8_t)n; p[1] = (uint8_t)(n >> 8); p[2] = (uint8_t)(n >> 16); p[3] = (uint8_t)(n >> 24);
}
static void tb_copy(char *out, const uint8_t *in, uint32_t n)
{
    uint32_t i;
    for (i = 0; i < n; i++) out[i] = in[i] >= 32u && in[i] <= 126u ? (char)in[i] : ' ';
    out[n] = 0;
}
static uint32_t tb_len(const char *s) { uint32_t n = 0; while (s[n]) n++; return n; }
static int tb_equal(const char *a, const char *b)
{
    while(*a&&*a==*b){a++;b++;}
    return *a==*b;
}
static void tb_append(char *out, const char *s, uint32_t max)
{
    uint32_t at = tb_len(out);
    while (*s && at + 1u < max) out[at++] = *s++;
    out[at] = 0;
}
static void tb_send(const uint8_t *body, uint32_t n)
{
    uint8_t raw[96], wire[112];
    uint32_t i, sum = 0, acc = 0, bits = 0, w = 1;
    if (n > 80u) return;
    raw[0] = 0; raw[1] = 0x59; raw[2] = TB_CMD; raw[3] = (uint8_t)n; raw[4] = raw[5] = 0;
    for (i = 0; i < n; i++) { raw[6 + i] = body[i]; sum += body[i]; }
    raw[6 + n] = (uint8_t)~sum;
    wire[0] = 0xF0;
    for (i = 0; i < n + 7u; i++) {
        acc |= (uint32_t)raw[i] << bits; bits += 8u;
        while (bits >= 7u) { wire[w++] = (uint8_t)(acc & 127u); acc >>= 7; bits -= 7u; }
    }
    if (bits) wire[w++] = (uint8_t)(acc & 127u);
    wire[w++] = 0xF7;
#ifdef PLAT_HOST
    printf("threadboard-out ");
    for (i = 0; i < w; i++) printf("%02x", wire[i]);
    printf("\n");
#endif
    plat_sysex_send(wire, w);
}
static int tb_linked(void) { return tb_have_snapshot && tb_connected && plat_ms() - tb_heard < 6000u; }
static void tb_notice(const char *s)
{
    uint32_t n = tb_len(s); if (n > 63u) n = 63u;
    tb_copy(tb_message, (const uint8_t *)s, n); tb_message_at = plat_ms(); tb_redraw = 1;
}
void app_say(const char *a, const char *b) { (void)b; tb_notice(a ? a : ""); }

void app_usb_cmd(const uint8_t *raw, uint32_t n)
{
    uint32_t len, sum = 0, i, session, revision;
    const uint8_t *b;
    if (n < 9u || raw[0] || raw[1] != 0x59u || raw[2] != TB_CMD) return;
    len = (uint32_t)raw[3] | ((uint32_t)raw[4] << 8) | ((uint32_t)raw[5] << 16);
    if (len + 7u != n) return;
    b = raw + 6;
    for (i = 0; i < len; i++) sum += b[i];
    if ((uint8_t)~sum != raw[n - 1u] || b[0] != TB_VERSION) return;
    if (b[1] == TB_ACK && len == 9u && tb_rd32(b + 2) == tb_session && tb_pending_on
        && ((uint32_t)b[6] | ((uint32_t)b[7] << 8)) == tb_pending_seq) {
        tb_pending_on = 0;
        tb_notice(b[8] ? "DONE" : "ACTION NOT APPLIED. CHECK THE BRIDGE.");
        return;
    }
    if (len < 10u) return;
    session = tb_rd32(b + 2); revision = tb_rd32(b + 6);
    if (b[1] == TB_BEGIN && len == 10u) {
        if (!session) return;
        if (session == tb_session && (int32_t)(revision - tb_revision) < 0) return;
        tb_stage_session = session; tb_stage_revision = revision; tb_mask = 0; tb_staging = 1; tb_question_received = 0;
        tb_result_size = tb_result_at = tb_result_received = 0; tb_stage_result[0] = 0;
        return;
    }
    if (!tb_staging || session != tb_stage_session || revision != tb_stage_revision) return;
    if (b[1] == TB_SLOT && len >= 19u) {
        uint32_t key = b[10], p = b[16], t = b[17], d = b[18];
        tb_slot_t *slot;
        uint32_t token;
        if (key >= NKEYS || b[11] > TB_UNAVAILABLE || p > 30u || t > 80u || d > 144u || 23u + p + t + d != len) return;
        token = tb_rd32(b + 12);
        if ((b[11] == TB_EMPTY) != (token == 0u)) return;
        slot = &tb_stage[key]; slot->state = b[11]; slot->token = token;
        slot->attention_serial = tb_rd32(b + 19 + p + t + d);
        tb_copy(slot->project, b + 19, p); tb_copy(slot->title, b + 19 + p, t); tb_copy(slot->detail, b + 19 + p + t, d);
        tb_mask |= 1u << key;
    } else if (b[1] == TB_QUESTION && len >= 22u) {
        uint32_t h=b[20],t=b[21];
        if(h>30u||t>240u||len!=22u+h+t||b[10]>15u||((b[10]&1u)&&(!b[12]||b[11]>=b[12]||!b[14]||b[13]>=b[14]||!tb_rd32(b+16))))return;
        tb_stage_question.flags=b[10];tb_stage_question.index=b[11];tb_stage_question.total=b[12];tb_stage_question.page=b[13];tb_stage_question.pages=b[14];tb_stage_question.answered=b[15];tb_stage_question.token=tb_rd32(b+16);
        tb_copy(tb_stage_question.header,b+22,h);tb_copy(tb_stage_question.text,b+22+h,t);tb_question_received=1;
    } else if (b[1] == TB_RESULT && len >= 14u && len <= 254u) {
        uint32_t total=(uint32_t)b[10]|((uint32_t)b[11]<<8),at=(uint32_t)b[12]|((uint32_t)b[13]<<8),count=len-14u;
        if(total>1200u||at!=tb_result_at||at+count>total||(!count&&total)||tb_result_received||(at&&total!=tb_result_size))return;
        tb_result_size=(uint16_t)total;tb_copy(tb_stage_result+at,b+14,count);tb_result_at=(uint16_t)(at+count);
        tb_result_received=tb_result_at==total;
    } else if (b[1] == TB_COMMIT && len == 14u && tb_mask == TB_ALL_KEYS && tb_question_received && tb_result_received && b[11] < NKEYS && (TB_THREAD_KEYS&(1u<<b[11])) && b[10] <= 1u) {
        uint8_t old_selected = tb_selected;
        uint32_t old_token = tb_slots[tb_selected].token;
        uint8_t chime = 0;
        for (i = 0; i < NKEYS; i++) {
            if ((TB_THREAD_KEYS&(1u<<i)) && tb_have_snapshot && b[10] && tb_stage[i].state == TB_ATTENTION && tb_stage[i].attention_serial
                && (tb_slots[i].token != tb_stage[i].token || tb_slots[i].attention_serial != tb_stage[i].attention_serial)) chime = 1;
            tb_slots[i] = tb_stage[i];
        }
        if (chime) tb_chime_requested++;
        if(tb_question.token!=tb_stage_question.token)tb_scroll=0;
        tb_question=tb_stage_question;
        if(!tb_equal(tb_result,tb_stage_result))tb_scroll=0;
        tb_copy(tb_result,(const uint8_t *)tb_stage_result,tb_result_size);
        if (session != tb_session) tb_pending_on = 0;
        tb_session = session; tb_revision = revision; tb_selected = b[11]; tb_connected = b[10];
        tb_overflow = (uint16_t)((uint32_t)b[12] | ((uint32_t)b[13] << 8));
        if (old_selected != tb_selected || old_token != tb_slots[tb_selected].token) tb_scroll = 0;
        tb_heard = plat_ms(); tb_have_snapshot = 1; tb_staging = 0; tb_redraw = 1;
    }
}

static void tb_action_value(uint32_t action, uint32_t key, int32_t value)
{
    uint32_t token = action>=TB_CHOOSE ? tb_question.token : key<NKEYS ? tb_slots[key].token : 0;
    if (!tb_linked()) { tb_notice("T3 IS NOT CONNECTED"); return; }
    if (tb_pending_on) { tb_notice("WAITING FOR T3"); return; }
    if (key >= NKEYS || (!tb_slots[key].token && action != TB_NEXT)) { tb_notice("THIS KEY IS AVAILABLE"); return; }
    if(action>=TB_CHOOSE&&(!(tb_question.flags&1u)||(tb_question.flags&8u))){tb_notice("NO ANSWERS TO SEND");return;}
    if(action==TB_CONFIRM&&!(tb_question.flags&4u)){tb_notice("ANSWER ALL REQUIRED QUESTIONS FIRST");return;}
    tb_pending[0] = TB_VERSION; tb_pending[1] = TB_ACTION;
    tb_wr32(tb_pending + 2, tb_session);
    tb_pending_seq = ++tb_sequence;
    tb_pending[6] = (uint8_t)tb_pending_seq; tb_pending[7] = (uint8_t)(tb_pending_seq >> 8);
    tb_pending[8] = (uint8_t)action; tb_pending[9] = (uint8_t)key;
    tb_wr32(tb_pending + 10, token); tb_pending[14]=(uint8_t)value;tb_pending[15]=(uint8_t)((uint32_t)value>>8);
    tb_last_action = (uint8_t)action; tb_last_token = token;
    tb_pending_on = 1; tb_retries = 0; tb_pending_at = plat_ms();
    tb_send(tb_pending, sizeof tb_pending);
    tb_notice(action==TB_CONFIRM?"SENDING ANSWERS...":action>=TB_CHOOSE?"UPDATING ANSWER...":action == TB_SETTLE ? "SETTLING THREAD..." : action == TB_STOP ? "STOPPING WORK..." : "OPENING THREAD...");
}
static void tb_action(uint32_t action,uint32_t key){tb_action_value(action,key,0);}
static void tb_input(void)
{
    uint32_t keys = plat_keys(), buttons = plat_buttons(), pressed = keys & ~tb_keys, down = buttons & ~tb_buttons, k;
    int32_t scroll;
    for (k = 0; k < NKEYS; k++) if (pressed & (1u << k)) {
        tb_help = 0;
        if (TB_THREAD_KEYS & (1u << k)) tb_action(buttons & (1u << B_SAVE) ? TB_SETTLE : TB_SELECT, k);
        else if(tb_question.flags&1u)tb_action(TB_CHOOSE,k);
        else tb_notice("NO QUESTION CHOICES FOR THIS THREAD");
    }
    if (down & (1u << B_SEL)) tb_action(TB_NEXT, tb_selected);
    if (down & (1u << B_REC)) tb_action(TB_STOP, tb_selected);
    if (down & (1u << B_PLAY)) tb_action(tb_question.flags&1u?TB_CONFIRM:TB_SELECT, tb_selected);
    if (down & (1u << B_HOME)) { tb_help = !tb_help; tb_redraw = 1; }
    scroll = plat_enc(EN_K1);
    if (scroll) { tb_scroll = clamp(tb_scroll + scroll, 0, 63); tb_redraw = 1; }
    scroll=plat_enc(EN_K2);if(scroll&&(tb_question.flags&1u))tb_action_value(TB_QSTEP,tb_selected,scroll<0?-1:1);
    scroll=plat_enc(EN_K3);if(scroll&&(tb_question.flags&1u))tb_action_value(TB_QPAGE,tb_selected,scroll<0?-1:1);
    for (k = 0; k < NE; k++) if (k != EN_K1&&k!=EN_K2&&k!=EN_K3) (void)plat_enc((int)k);
    tb_keys = keys; tb_buttons = buttons;
}
static void tb_number(uint32_t n, char *out)
{
    char tmp[12]; uint32_t len = 0, i;
    do { tmp[len++] = (char)('0' + n % 10u); n /= 10u; } while (n);
    for (i = 0; i < len; i++) out[i] = tmp[len - i - 1u]; out[len] = 0;
}
static uint32_t tb_wrap(const char *text, char lines[][40], uint32_t limit, const felucca_font_t *font)
{
    uint32_t line = 0, at = 0;
    while (*text && line < limit) {
        uint32_t last_space = 0;
        at = 0;
        while (text[at] && at < 38u) {
            lines[line][at] = text[at]; lines[line][at + 1u] = 0;
            if (text_w(font, lines[line]) > 220) break;
            if (text[at] == ' ') last_space = at;
            at++;
        }
        if (!at) at = 1;
        if (text[at] && last_space) at = last_space;
        lines[line][at] = 0; text += at;
        while (*text == ' ') text++;
        line++;
    }
    return line;
}
static void tb_draw(void)
{
    tb_slot_t *slot = &tb_slots[tb_selected];
    uint32_t band, i, n_title, n_detail, assigned = 0, need = 0, work = 0;
    char title[4][40], detail[12][40], question_lines[64][40], number[12], counts[40], part[12];
    uint32_t question_n=0;
    int result_on=tb_result[0]&&!(tb_question.flags&1u);
    const char *state = slot->state == TB_ATTENTION ? "NEEDS YOU" : slot->state == TB_WORKING ? "WORKING" : slot->state == TB_IDLE ? "READY" : slot->state == TB_UNAVAILABLE ? "UNAVAILABLE" : "AVAILABLE KEY";
    for (i = 0; i < NKEYS; i++) if(TB_THREAD_KEYS&(1u<<i)){ assigned += tb_slots[i].token != 0; need += tb_slots[i].state == TB_ATTENTION; work += tb_slots[i].state == TB_WORKING; }
    n_title = tb_wrap(slot->token ? slot->title : "Press an assigned key", title, 4, &FONT_B);
    n_detail = tb_wrap(slot->detail, detail, 12, &FONT_S);
    if(tb_question.flags&1u){
        uint32_t option=0;char label[100];
        question_n=tb_wrap(tb_question.text,question_lines,8,&FONT_XS);
        for(i=0;i<NKEYS;i++)if(!(TB_THREAD_KEYS&(1u<<i))){
            option++;if(!tb_slots[i].token)continue;
            label[0]=0;tb_number(option,part);tb_append(label,part,sizeof label);tb_append(label,tb_slots[i].state==TB_ATTENTION?" [x] ":" [ ] ",sizeof label);tb_append(label,tb_slots[i].title,sizeof label);
            if(question_n<41u)question_n+=tb_wrap(label,&question_lines[question_n],3,&FONT_XS);
        }
    }
    if(result_on)question_n=tb_wrap(tb_result,question_lines,64,&FONT_XS);
    tb_scroll = clamp(tb_scroll, 0, result_on?(question_n>7u?(int32_t)question_n-7:0):tb_question.flags&1u?(question_n>10u?(int32_t)question_n-10:0):n_detail > 3u ? (int32_t)n_detail - 3 : 0);
    { uint32_t position = 0; for (i = 0; i <= tb_selected; i++) position += (TB_THREAD_KEYS >> i) & 1u; tb_number(position, number); }
    counts[0] = 0;
    tb_number(need, part); tb_append(counts, part, sizeof counts); tb_append(counts, " need you   ", sizeof counts);
    tb_number(work, part); tb_append(counts, part, sizeof counts); tb_append(counts, " working", sizeof counts);
    for (band = 0; band < 240u; band += 48u) {
        int32_t y = -(int32_t)band;
        cv_begin(240, 48, C_BLACK);
        cv_text(10, y + 8, &FONT_XS, "THREADBOARD", C_GRAY);
        cv_text(188, y + 8, &FONT_XS, number, C_HI);
        if (!tb_linked()) {
            cv_text(10, y + 50, &FONT_B, "T3 DISCONNECTED", C_WHITE);
            cv_text(10, y + 88, &FONT_S, "Your key assignments", C_GRAY);
            cv_text(10, y + 108, &FONT_S, "stay on your Mac.", C_GRAY);
            cv_text(10, y + 150, &FONT_S, "Start Threadboard", C_HI);
            cv_text(10, y + 170, &FONT_S, "and connect USB.", C_HI);
        } else if (tb_help) {
            cv_text(10, y + 42, &FONT_B, "CONTROLS", C_WHITE);
            cv_text(10, y + 76, &FONT_S, "WHITE KEY   Open thread", C_GRAY);
            cv_text(10, y + 100, &FONT_S, "SEL   Next needing you", C_GRAY);
            cv_text(10, y + 124, &FONT_S, "REC   Stop work", C_GRAY);
            cv_text(10, y + 148, &FONT_S, "SAVE + KEY   Settle", C_GRAY);
            cv_text(10, y + 172, &FONT_S, "K1   Scroll preview", C_GRAY);
        } else if(tb_question.flags&1u){
            cv_text(10,y+28,&FONT_XS,tb_question.header,C_HI);
            for(i=0;i<10u&&i+(uint32_t)tb_scroll<question_n;i++)cv_text(10,y+44+(int32_t)i*14,&FONT_XS,question_lines[i+(uint32_t)tb_scroll],C_WHITE);
            cv_text(10,y+188,&FONT_XS,tb_question.flags&8u?"SENT. WAIT FOR T3":tb_question.flags&4u?"PLAY: SEND ANSWERS":"BLACK: CHOOSE / K2: QUESTION",C_HI);
            tb_number(tb_question.index+1u,part);cv_text(10,y+202,&FONT_XS,part,C_GRAY);cv_text(30,y+202,&FONT_XS,"K1: SCROLL  K3: PAGE",C_GRAY);
        } else if(result_on){
            cv_text(10,y+28,&FONT_XS,slot->project,C_GRAY);
            for(i=0;i<n_title&&i<2u;i++)cv_text(10,y+46+(int32_t)i*18,&FONT_B,title[i],C_WHITE);
            cv_text(10,y+84,&FONT_XS,"RESULT EXCERPT",C_HI);
            for(i=0;i<7u&&i+(uint32_t)tb_scroll<question_n;i++)cv_text(10,y+102+(int32_t)i*14,&FONT_XS,question_lines[i+(uint32_t)tb_scroll],C_WHITE);
            cv_text(10,y+212,&FONT_XS,tb_message[0]&&plat_ms()-tb_message_at<2000u?tb_message:"K1: SCROLL  PLAY: OPEN T3",C_HI);
            cv_text(10,y+226,&FONT_XS,"SAVE + WHITE KEY: SETTLE",C_GRAY);
        } else {
            cv_text(10, y + 32, &FONT_XS, slot->project, C_GRAY);
            for (i = 0; i < n_title; i++) cv_text(10, y + 56 + (int32_t)i * 18, &FONT_B, title[i], C_WHITE);
            cv_text(10, y + 132, &FONT_XS, state, C_HI);
            for (i = 0; i < 3u && i + (uint32_t)tb_scroll < n_detail; i++) cv_text(10, y + 154 + (int32_t)i * 17, &FONT_S, detail[i + (uint32_t)tb_scroll], C_GRAY);
        }
        if (!result_on && tb_message[0] && plat_ms() - tb_message_at < 2000u) cv_text(10, y + (tb_question.flags&1u?226:212), &FONT_XS, tb_message, C_HI);
        else if (!result_on && tb_overflow) {
            tb_number(tb_overflow, part); cv_text(10, y + 212, &FONT_XS, part, C_HI); cv_text(35, y + 212, &FONT_XS, "waiting for a free key", C_GRAY);
        } else if(!result_on) cv_text(10, y + 212, &FONT_XS, counts, C_GRAY);
        cv_blit(0, band);
    }
    (void)assigned;
}
static void tb_lights(void)
{
    uint32_t bright = 0, dim = 0, mid = 0, k, buttons = 1u << B_HOME;
    int linked = tb_linked();
    for (k = 0; k < NKEYS; k++) {
        const tb_slot_t *s = &tb_slots[k];
        if (s->token) dim |= 1u << k;
        if (linked && (tb_question.flags & 1u) && !(tb_question.flags & 8u) && !(TB_THREAD_KEYS & (1u << k)) && s->token && s->state == TB_IDLE) mid |= 1u << k;
        if (linked && (s->state == TB_WORKING || (s->state == TB_ATTENTION && (!(TB_THREAD_KEYS & (1u << k)) || (plat_ms() / 500u & 1u))))) bright |= 1u << k;
    }
    if (linked) buttons |= 1u << B_SEL;
    if(linked&&(tb_question.flags&4u))buttons|=1u<<B_PLAY;
    tb_bright = bright; tb_mid = mid; tb_dim = dim & ~(bright | mid);
    plat_lights(buttons, bright, 0, tb_dim, 1);
    plat_lights_mid(0, mid);
}
void app_init(void)
{
    uint32_t i;
    for (i = 0; i < NKEYS; i++) { tb_slots[i].token = tb_slots[i].attention_serial = 0; tb_slots[i].state = TB_EMPTY; tb_slots[i].project[0] = tb_slots[i].title[0] = tb_slots[i].detail[0] = 0; }
    tb_session = tb_revision = tb_stage_session = tb_stage_revision = tb_mask = 0;
    tb_have_snapshot = tb_staging = tb_connected = tb_pending_on = tb_selected = tb_help = 0;
    tb_keys = tb_buttons = tb_hello_at = tb_sequence = 0; tb_scroll = 0; tb_message[0] = 0;
    tb_last_action = 255u; tb_last_token = 0; tb_redraw = 1;
    tb_question.flags=tb_stage_question.flags=tb_question_received=0;tb_question.token=tb_stage_question.token=0;
    tb_result[0]=tb_stage_result[0]=0;tb_result_size=tb_result_at=tb_result_received=0;
    tb_chime_requested = tb_chime_seen = 0; tb_chime_frame = 13230u; tb_chime_phase = 0;
}
void app_render(int32_t *lr, uint32_t n, uint32_t master_q12)
{
    uint32_t i;
    if (tb_chime_seen != tb_chime_requested) { tb_chime_seen = tb_chime_requested; tb_chime_frame = 0; tb_chime_phase = 0; }
    for (i = 0; i < n; i++) {
        int32_t sample = 0;
        if (tb_chime_frame < 13230u) {
            uint32_t f = tb_chime_frame % 6615u;
            float envelope = f < 441u ? (float)f / 441.0f : (float)(6615u - f) / 6174.0f;
            float hz = tb_chime_frame < 6615u ? 783.99f : 1046.50f;
            if (!f) tb_chime_phase = 0;
            tb_chime_phase += hz / 44100.0f;
            if (tb_chime_phase >= 1.0f) tb_chime_phase -= 1.0f;
            sample = (int32_t)(fm_sinf(tb_chime_phase * 6.2831853f) * envelope * 1000000.0f * ((float)master_q12 / 4096.0f));
            tb_chime_frame++;
        }
        lr[2u * i] = lr[2u * i + 1u] = sample;
    }
}
void app_panic(void) {}
void app_ui_init(void) { palette_set(2); tb_redraw = 1; tb_draw(); }
void app_input_only(void) { tb_input(); }
void app_frame(void)
{
    uint32_t now = plat_ms();
    tb_input();
    if ((!tb_have_snapshot || now - tb_heard >= 6000u) && now - tb_hello_at >= 1000u) { const uint8_t hello[] = {TB_VERSION, TB_HELLO}; tb_send(hello, sizeof hello); tb_hello_at = now; tb_redraw = 1; }
    if (tb_pending_on && now - tb_pending_at > 700u) {
        if (++tb_retries < 5u && tb_linked()) { tb_send(tb_pending, sizeof tb_pending); tb_pending_at = now; }
        else { tb_pending_on = 0; tb_notice("T3 DID NOT CONFIRM THE ACTION"); }
    }
    if (tb_message[0] && now - tb_message_at >= 2000u) { tb_message[0] = 0; tb_redraw = 1; }
    tb_lights();
    if (tb_redraw) { tb_redraw = 0; tb_draw(); }
}

#ifdef PLAT_HOST
/* Feed the exact bridge wire frames to the same command handler in host tests. */
int app_host_cmd(const char *cmd, const char *a, const char *b, const char *c, const char *d)
{
    static uint8_t wire[400]; static uint32_t n;
    uint8_t raw[350]; uint32_t r = 0, acc = 0, bits = 0, i; unsigned byte;
    const char *p = plat_host_line;
    (void)a; (void)b; (void)c; (void)d;
    if (!strcmp(cmd, "wire_clear")) { n = 0; return 1; }
    if (!strcmp(cmd, "wire_end")) {
        if (n < 3u || wire[0] != 0xF0 || wire[n - 1u] != 0xF7) return 1;
        for (i = 1; i + 1u < n; i++) { if (wire[i] > 127u) return 1; acc |= (uint32_t)wire[i] << bits; bits += 7u; while (bits >= 8u && r < sizeof raw) { raw[r++] = (uint8_t)acc; acc >>= 8; bits -= 8u; } }
        app_usb_cmd(raw, r); return 1;
    }
    if (strcmp(cmd, "wire")) return 0;
    while (*p && *p != ' ') p++;
    while (*p && n < sizeof wire) { while (*p == ' ') p++; if (!*p) break; if (sscanf(p, "%2x", &byte) != 1) return 1; wire[n++] = (uint8_t)byte; while (*p && *p != ' ') p++; }
    return 1;
}
int app_expect(const char *what, int *got)
{
    int key;
    if (!strcmp(what, "linked")) *got = tb_linked();
    else if (!strcmp(what, "selected")) *got = tb_selected;
    else if (!strcmp(what, "bright")) *got = (int)tb_bright;
    else if (!strcmp(what, "dim")) *got = (int)tb_dim;
    else if (!strcmp(what, "mid")) *got = (int)tb_mid;
    else if (!strcmp(what, "answer_lights")) *got = (int)(tb_bright & ~TB_THREAD_KEYS);
    else if (!strcmp(what, "result_len")) *got = (int)tb_len(tb_result);
    else if (!strcmp(what, "scroll")) *got = tb_scroll;
    else if (!strcmp(what, "scrolled")) *got = tb_scroll>0;
    else if (!strcmp(what, "action")) *got = tb_last_action;
    else if (!strcmp(what, "action_token")) *got = (int)tb_last_token;
    else if (!strcmp(what, "pending")) *got = tb_pending_on;
    else if (!strcmp(what, "chimes")) *got = (int)tb_chime_requested;
    else if (!strcmp(what, "question")) *got = (tb_question.flags&1u)!=0;
    else if (!strcmp(what, "question_token")) *got = (int)tb_question.token;
    else if (!strcmp(what, "question_index")) *got = tb_question.index;
    else if (!strcmp(what, "question_ready")) *got = (tb_question.flags&4u)!=0;
    else if (sscanf(what, "answer%d", &key) == 1 && key >= 0 && key < NKEYS) *got = tb_slots[key].state==TB_ATTENTION;
    else if (sscanf(what, "slot%d", &key) == 1 && key >= 0 && key < NKEYS) *got = (int)tb_slots[key].token;
    else return 0;
    return 1;
}
void app_host_reboot(void) { app_init(); }
#endif
