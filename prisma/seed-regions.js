"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var client_1 = require("@prisma/client");
var prisma = new client_1.PrismaClient();
var BASE_URL = "https://emsifa.github.io/api-wilayah-indonesia/api";
function fetchJson(url) {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch(url)];
                case 1:
                    response = _a.sent();
                    if (!response.ok) {
                        throw new Error("HTTP ".concat(response.status, " saat mengambil ").concat(url));
                    }
                    return [2 /*return*/, response.json()];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var provinces, _i, provinces_1, province, totalRegencies, _a, provinces_2, province, regencies, _b, regencies_1, regency, totalDistricts, _c, provinces_3, province, regencies, _d, regencies_2, regency, districts, _e, districts_1, district, totalVillages, _f, provinces_4, province, regencies, _g, regencies_3, regency, districts, _h, districts_2, district, villages, _j, villages_1, village;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    console.log("======================================");
                    console.log("SEED WILAYAH INDONESIA");
                    console.log("======================================");
                    console.log("Sumber: api-wilayah-indonesia");
                    console.log("Tidak menggunakan RajaOngkir.");
                    console.log("");
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/provinces.json"))];
                case 1:
                    provinces = _k.sent();
                    console.log("Province ditemukan: ".concat(provinces.length));
                    _i = 0, provinces_1 = provinces;
                    _k.label = 2;
                case 2:
                    if (!(_i < provinces_1.length)) return [3 /*break*/, 5];
                    province = provinces_1[_i];
                    return [4 /*yield*/, prisma.province.upsert({
                            where: {
                                id: Number(province.id),
                            },
                            update: {
                                name: province.name,
                            },
                            create: {
                                id: Number(province.id),
                                name: province.name,
                            },
                        })];
                case 3:
                    _k.sent();
                    _k.label = 4;
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5:
                    console.log("✓ Province selesai");
                    totalRegencies = 0;
                    _a = 0, provinces_2 = provinces;
                    _k.label = 6;
                case 6:
                    if (!(_a < provinces_2.length)) return [3 /*break*/, 13];
                    province = provinces_2[_a];
                    console.log("\nProvince: ".concat(province.name));
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/regencies/").concat(province.id, ".json"))];
                case 7:
                    regencies = _k.sent();
                    _b = 0, regencies_1 = regencies;
                    _k.label = 8;
                case 8:
                    if (!(_b < regencies_1.length)) return [3 /*break*/, 11];
                    regency = regencies_1[_b];
                    return [4 /*yield*/, prisma.regency.upsert({
                            where: {
                                id: Number(regency.id),
                            },
                            update: {
                                provinceId: Number(regency.province_id),
                                name: regency.name,
                            },
                            create: {
                                id: Number(regency.id),
                                provinceId: Number(regency.province_id),
                                name: regency.name,
                            },
                        })];
                case 9:
                    _k.sent();
                    totalRegencies++;
                    _k.label = 10;
                case 10:
                    _b++;
                    return [3 /*break*/, 8];
                case 11:
                    console.log("  \u2713 Regency: ".concat(regencies.length));
                    _k.label = 12;
                case 12:
                    _a++;
                    return [3 /*break*/, 6];
                case 13:
                    console.log("\n\u2713 Total Regency: ".concat(totalRegencies));
                    totalDistricts = 0;
                    _c = 0, provinces_3 = provinces;
                    _k.label = 14;
                case 14:
                    if (!(_c < provinces_3.length)) return [3 /*break*/, 24];
                    province = provinces_3[_c];
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/regencies/").concat(province.id, ".json"))];
                case 15:
                    regencies = _k.sent();
                    _d = 0, regencies_2 = regencies;
                    _k.label = 16;
                case 16:
                    if (!(_d < regencies_2.length)) return [3 /*break*/, 22];
                    regency = regencies_2[_d];
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/districts/").concat(regency.id, ".json"))];
                case 17:
                    districts = _k.sent();
                    _e = 0, districts_1 = districts;
                    _k.label = 18;
                case 18:
                    if (!(_e < districts_1.length)) return [3 /*break*/, 21];
                    district = districts_1[_e];
                    return [4 /*yield*/, prisma.district.upsert({
                            where: {
                                id: Number(district.id),
                            },
                            update: {
                                regencyId: Number(district.regency_id),
                                name: district.name,
                            },
                            create: {
                                id: Number(district.id),
                                regencyId: Number(district.regency_id),
                                name: district.name,
                            },
                        })];
                case 19:
                    _k.sent();
                    totalDistricts++;
                    _k.label = 20;
                case 20:
                    _e++;
                    return [3 /*break*/, 18];
                case 21:
                    _d++;
                    return [3 /*break*/, 16];
                case 22:
                    console.log("\u2713 District province ".concat(province.name));
                    _k.label = 23;
                case 23:
                    _c++;
                    return [3 /*break*/, 14];
                case 24:
                    console.log("\n\u2713 Total District: ".concat(totalDistricts));
                    totalVillages = 0;
                    _f = 0, provinces_4 = provinces;
                    _k.label = 25;
                case 25:
                    if (!(_f < provinces_4.length)) return [3 /*break*/, 38];
                    province = provinces_4[_f];
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/regencies/").concat(province.id, ".json"))];
                case 26:
                    regencies = _k.sent();
                    _g = 0, regencies_3 = regencies;
                    _k.label = 27;
                case 27:
                    if (!(_g < regencies_3.length)) return [3 /*break*/, 36];
                    regency = regencies_3[_g];
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/districts/").concat(regency.id, ".json"))];
                case 28:
                    districts = _k.sent();
                    _h = 0, districts_2 = districts;
                    _k.label = 29;
                case 29:
                    if (!(_h < districts_2.length)) return [3 /*break*/, 35];
                    district = districts_2[_h];
                    return [4 /*yield*/, fetchJson("".concat(BASE_URL, "/villages/").concat(district.id, ".json"))];
                case 30:
                    villages = _k.sent();
                    _j = 0, villages_1 = villages;
                    _k.label = 31;
                case 31:
                    if (!(_j < villages_1.length)) return [3 /*break*/, 34];
                    village = villages_1[_j];
                    return [4 /*yield*/, prisma.village.upsert({
                            where: {
                                id: Number(village.id),
                            },
                            update: {
                                districtId: Number(village.district_id),
                                name: village.name,
                            },
                            create: {
                                id: Number(village.id),
                                districtId: Number(village.district_id),
                                name: village.name,
                            },
                        })];
                case 32:
                    _k.sent();
                    totalVillages++;
                    _k.label = 33;
                case 33:
                    _j++;
                    return [3 /*break*/, 31];
                case 34:
                    _h++;
                    return [3 /*break*/, 29];
                case 35:
                    _g++;
                    return [3 /*break*/, 27];
                case 36:
                    console.log("\u2713 Village province ".concat(province.name));
                    _k.label = 37;
                case 37:
                    _f++;
                    return [3 /*break*/, 25];
                case 38:
                    console.log("\n\u2713 Total Village: ".concat(totalVillages));
                    /*
                     * ==========================================
                     * DONE
                     * ==========================================
                     */
                    console.log("");
                    console.log("======================================");
                    console.log("SEED SELESAI");
                    console.log("======================================");
                    console.log("Province : ".concat(provinces.length));
                    console.log("Regency  : ".concat(totalRegencies));
                    console.log("District : ".concat(totalDistricts));
                    console.log("Village  : ".concat(totalVillages));
                    console.log("======================================");
                    return [2 /*return*/];
            }
        });
    });
}
main()
    .catch(function (error) {
    console.error("");
    console.error("❌ REGION SEED ERROR:");
    console.error(error);
    process.exit(1);
})
    .finally(function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, prisma.$disconnect()];
            case 1:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); });
