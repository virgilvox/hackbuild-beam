// servo_base_lego.scad
// SG90 / 9g servo pan base, shaft up, on a LEGO-standard plate footprint.
// Prints flat, no supports. Press fit servo, no fasteners.
// Moheeb Zara / hack.build

/* ---------------- LEGO STANDARD (do not change) ---------------- */
P        = 8.0;    // stud pitch
STUD_D   = 4.8;    // stud diameter
STUD_H   = 1.8;    // stud height
PLATE_H  = 3.2;    // plate height (brick = 9.6 = 3 plates)
WALL     = 1.5;    // side wall thickness
ROOF     = 1.0;    // top skin thickness -> 2.2 cavity, clears 1.8 studs
TUBE_OD  = 6.51;   // underside anti-stud tube
TUBE_ID  = 4.8;
GAP      = 0.2;    // total footprint undersize (7.8 per module)

/* ---------------- tuning ---------------- */
clutch   = 0.05;   // per-surface clearance added to the stud grip (FDM)
                   // 0    = nominal LEGO, tight on most printers
                   // 0.05 = firm, default
                   // 0.10 = easy on/off

nx       = 6;      // footprint in studs
ny       = 6;

srv_l    = 22.8;   // SG90 body length
srv_w    = 12.2;   // SG90 body width
fit      = 0.4;    // total press-fit clearance, 0.2 tight .. 0.6 loose
grip     = 16.0;   // socket depth, flange lands on the rim
sock_w   = 2.0;    // socket wall

n_webs   = 6;      // buttresses, 4..8
web_t    = 2.0;    // buttress thickness
web_r    = 16.5;   // buttress reach from center
top_studs = true;  // studs on the exposed perimeter, so you can stack

notch_w  = 6;      // cable channel width: full depth, rim to baseplate

$fn = 48;

/* ---------------- derived ---------------- */
FW  = nx*P - GAP;
FD  = ny*P - GAP;
CX  = FW/2;
CY  = FD/2;
CAV = PLATE_H - ROOF;          // 2.2 underside cavity
SL  = srv_l + fit;             // socket cavity
SW  = srv_w + fit;
TOP = CAV + grip;              // rim height, 18.2 default
COL = TOP - PLATE_H;           // collar height above the plate
TR  = TUBE_OD/2 - clutch;
WI  = WALL + clutch;           // inner wall face

// stud grid, part-local: centers at P/2 - GAP/2 + i*P
function sx(i) = P/2 - GAP/2 + i*P;
// tube grid, interstitial: P - GAP/2 + i*P
function tx(i) = P - GAP/2 + i*P;

// circle vs socket-rect overlap, used to cull tubes under the servo
function clash(x, y) =
    let (dx = max(0, abs(x-CX) - SL/2),
         dy = max(0, abs(y-CY) - SW/2))
    (dx*dx + dy*dy) < (TR+0.4)*(TR+0.4);

/* ---------------- LEGO plate ---------------- */
module plate() {
    difference() {
        cube([FW, FD, PLATE_H]);
        translate([WI, WI, -1]) cube([FW-2*WI, FD-2*WI, CAV+1]);
    }
    for (i = [0:nx-2], j = [0:ny-2])
        if (!clash(tx(i), tx(j)))
            translate([tx(i), tx(j), 0])
                difference() {
                    cylinder(h=CAV, d=TUBE_OD-2*clutch);
                    translate([0,0,-1]) cylinder(h=CAV+2, d=TUBE_ID);
                }
}

module studs() {
    for (i = [0:nx-1], j = [0:ny-1]) {
        d = norm([sx(i)-CX, sx(j)-CY]);
        if (d > web_r + STUD_D/2 + 1)
            translate([sx(i), sx(j), PLATE_H])
                cylinder(h=STUD_H, d=STUD_D);
    }
}

/* ---------------- servo collar ---------------- */
module collar() {
    // plinth, thickens the roof where the load lands
    translate([CX, CY, PLATE_H])
        linear_extrude(2.0)
            offset(r=3, $fn=32) square([SL+2*sock_w-6, SW+2*sock_w-6], center=true);
    // socket walls
    translate([CX, CY, PLATE_H])
        linear_extrude(COL)
            square([SL+2*sock_w, SW+2*sock_w], center=true);
}

module webs() {
    for (k = [0:n_webs-1]) {
        a = 360/n_webs * k + (n_webs%2 ? 0 : 180/n_webs);
        rotate([0,0,a])
            intersection() {
                hull() {
                    /* root, anchored at the collar centre so the buttress
                       always fuses to the socket wall at every angle */
                    translate([0, -web_t/2, PLATE_H])
                        cube([SL/2 + 2, web_t, COL*0.72], center=false);
                    // foot, on the plate
                    translate([web_r-3, -web_t/2, PLATE_H])
                        cube([3, web_t, 1.6]);
                }
                translate([-web_t/2, -web_t/2, PLATE_H])
                    cube([web_r, web_t, COL]);
            }
    }
}

/* ---------------- cuts ---------------- */
module cuts() {
    // servo pocket, open all the way through
    translate([CX, CY, -1])
        linear_extrude(TOP+2) square([SL, SW], center=true);
    // lead-in chamfer at the rim
    translate([CX, CY, TOP-0.8])
        hull() {
            linear_extrude(0.01) square([SL, SW], center=true);
            translate([0,0,0.8]) linear_extrude(0.01) square([SL+1.6, SW+1.6], center=true);
        }
    /* cable channel: a straight slot through the end wall, the plinth and
       the roof skin, open from the rim all the way to the baseplate, so the
       wire drops in with the servo instead of jamming against the rim */
    translate([CX - SL/2 - sock_w - 1, CY - notch_w/2, -1])
        cube([sock_w + 2, notch_w, TOP + 2]);
    // flared mouth at the rim so the wire feeds itself
    translate([CX - SL/2 - sock_w - 1, CY, TOP - 1.6])
        hull() {
            linear_extrude(0.01) square([2*(sock_w + 1), notch_w], center=true);
            translate([0, 0, 1.6])
                linear_extrude(0.01) square([2*(sock_w + 1), notch_w + 2.4], center=true);
        }
}

/* ---------------- assembly ---------------- */
difference() {
    union() {
        plate();
        if (top_studs) studs();
        translate([CX, CY, 0]) webs();
        collar();
    }
    cuts();
}
