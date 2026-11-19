#!/usr/bin/env python3
"""«Гроші ОК» — програма для підрахунку щомісячних витрат.

Запуск без аргументів відкриває інтерактивне меню.
Також можна користуватися командами:

    python3 groshi_ok.py add 250 Їжа "Продукти в АТБ"
    python3 groshi_ok.py add 1200 Комуналка --date 2026-11-05
    python3 groshi_ok.py list
    python3 groshi_ok.py report 2026-11
    python3 groshi_ok.py budget 15000
    python3 groshi_ok.py delete 3
    python3 groshi_ok.py export 2026-11

Дані зберігаються у файлі groshi_ok.json поруч із програмою
(або у файлі, вказаному у змінній середовища GROSHI_OK_FILE).
"""

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

DATA_FILE = Path(os.environ.get("GROSHI_OK_FILE", Path(__file__).with_name("groshi_ok.json")))
CURRENCY = "грн"
DEFAULT_CATEGORIES = [
    "Їжа", "Житло", "Комуналка", "Транспорт", "Здоров'я",
    "Одяг", "Зв'язок", "Розваги", "Освіта", "Інше",
]
MONTHS_UA = [
    "", "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень",
]


# ---------- Зберігання даних ----------

def load_data():
    if DATA_FILE.exists():
        with open(DATA_FILE, encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {}
    data.setdefault("expenses", [])
    data.setdefault("budget", None)
    data.setdefault("next_id", max((e["id"] for e in data["expenses"]), default=0) + 1)
    return data


def save_data(data):
    tmp = DATA_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(DATA_FILE)


# ---------- Допоміжні функції ----------

def parse_amount(text):
    value = float(str(text).replace(" ", "").replace(",", "."))
    if value <= 0:
        raise ValueError("Сума має бути більшою за нуль")
    return round(value, 2)


def parse_date(text):
    if not text:
        return date.today().isoformat()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d.%m"):
        try:
            d = datetime.strptime(text, fmt).date()
            if fmt == "%d.%m":
                d = d.replace(year=date.today().year)
            return d.isoformat()
        except ValueError:
            pass
    raise ValueError("Дата має бути у форматі РРРР-ММ-ДД або ДД.ММ.РРРР")


def parse_month(text):
    if not text:
        return date.today().strftime("%Y-%m")
    for fmt in ("%Y-%m", "%m.%Y", "%m/%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m")
        except ValueError:
            pass
    raise ValueError("Місяць має бути у форматі РРРР-ММ, напр. 2026-11")


def month_title(month):
    year, m = month.split("-")
    return f"{MONTHS_UA[int(m)]} {year}"


def money(value):
    return f"{value:,.2f}".replace(",", " ") + f" {CURRENCY}"


def normalize_category(name):
    name = name.strip()
    for cat in DEFAULT_CATEGORIES:
        if cat.lower() == name.lower():
            return cat
    return name.capitalize() if name else "Інше"


def expenses_for_month(data, month):
    return sorted(
        (e for e in data["expenses"] if e["date"].startswith(month)),
        key=lambda e: (e["date"], e["id"]),
    )


# ---------- Дії ----------

def add_expense(data, amount, category, note="", when=None):
    expense = {
        "id": data["next_id"],
        "date": parse_date(when),
        "amount": parse_amount(amount),
        "category": normalize_category(category),
        "note": note.strip(),
    }
    data["expenses"].append(expense)
    data["next_id"] += 1
    save_data(data)
    print(f"✔ Додано #{expense['id']}: {money(expense['amount'])} — "
          f"{expense['category']} ({expense['date']})")


def delete_expense(data, expense_id):
    before = len(data["expenses"])
    data["expenses"] = [e for e in data["expenses"] if e["id"] != expense_id]
    if len(data["expenses"]) == before:
        print(f"✘ Витрату #{expense_id} не знайдено")
        return
    save_data(data)
    print(f"✔ Витрату #{expense_id} видалено")


def set_budget(data, amount):
    data["budget"] = parse_amount(amount)
    save_data(data)
    print(f"✔ Місячний бюджет: {money(data['budget'])}")


def list_expenses(data, month):
    items = expenses_for_month(data, month)
    print(f"\nВитрати — {month_title(month)}")
    if not items:
        print("  Немає записів.")
        return
    print(f"  {'#':>4}  {'Дата':<10}  {'Сума':>14}  {'Категорія':<12}  Примітка")
    print("  " + "-" * 64)
    for e in items:
        print(f"  {e['id']:>4}  {e['date']:<10}  {money(e['amount']):>14}  "
              f"{e['category']:<12}  {e['note']}")
    print("  " + "-" * 64)
    print(f"  Разом: {money(sum(e['amount'] for e in items))}")


def report(data, month):
    items = expenses_for_month(data, month)
    total = sum(e["amount"] for e in items)
    print(f"\n══ Звіт «Гроші ОК» — {month_title(month)} ══")
    if not items:
        print("  За цей місяць витрат немає.")
    else:
        by_cat = defaultdict(float)
        for e in items:
            by_cat[e["category"]] += e["amount"]
        print(f"\n  {'Категорія':<14}{'Сума':>16}{'Частка':>9}")
        for cat, amount in sorted(by_cat.items(), key=lambda kv: -kv[1]):
            share = amount / total * 100
            bar = "█" * round(share / 5)
            print(f"  {cat:<14}{money(amount):>16}{share:>8.1f}%  {bar}")
        print(f"\n  Усього витрачено: {money(total)}  (записів: {len(items)})")

        # Середнє на день
        y, m = map(int, month.split("-"))
        today = date.today()
        if (y, m) == (today.year, today.month):
            days = today.day
        else:
            next_month = date(y + m // 12, m % 12 + 1, 1)
            days = (next_month - date(y, m, 1)).days
        print(f"  У середньому на день: {money(total / days)}")

        biggest = max(items, key=lambda e: e["amount"])
        print(f"  Найбільша витрата: {money(biggest['amount'])} — "
              f"{biggest['category']} {biggest['note']}".rstrip())

        # Порівняння з попереднім місяцем
        prev = f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"
        prev_total = sum(e["amount"] for e in expenses_for_month(data, prev))
        if prev_total:
            diff = total - prev_total
            sign = "+" if diff >= 0 else "−"
            print(f"  Проти попереднього місяця ({month_title(prev)}): "
                  f"{sign}{money(abs(diff))} ({diff / prev_total * 100:+.1f}%)")

    budget = data.get("budget")
    if budget:
        left = budget - total
        used = total / budget * 100
        print(f"\n  Бюджет: {money(budget)}  |  використано {used:.1f}%")
        if left >= 0:
            status = "✅ Гроші ОК!" if used < 90 else "⚠️ Обережно, бюджет майже вичерпано"
            print(f"  Залишок: {money(left)}  →  {status}")
        else:
            print(f"  Перевитрата: {money(-left)}  →  ❌ Бюджет перевищено")
    else:
        print("\n  Порада: встановіть місячний бюджет командою «budget».")


def export_csv(data, month):
    items = expenses_for_month(data, month)
    path = DATA_FILE.with_name(f"groshi_ok_{month}.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(["ID", "Дата", "Сума", "Категорія", "Примітка"])
        for e in items:
            writer.writerow([e["id"], e["date"], f"{e['amount']:.2f}".replace(".", ","),
                             e["category"], e["note"]])
    print(f"✔ Експортовано записів: {len(items)} → {path}")


# ---------- Інтерактивне меню ----------

def ask(prompt, default=None):
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or (default or "")


def interactive(data):
    actions = {
        "1": "Додати витрату",
        "2": "Показати витрати за місяць",
        "3": "Звіт за місяць",
        "4": "Встановити місячний бюджет",
        "5": "Видалити витрату",
        "6": "Експорт у CSV (Excel)",
        "0": "Вихід",
    }
    print("💰 Вітаємо у «Гроші ОК»!")
    while True:
        print()
        for key, label in actions.items():
            print(f"  {key}. {label}")
        choice = input("Оберіть дію: ").strip()
        try:
            if choice == "1":
                amount = ask("Сума")
                print("  Категорії: " + ", ".join(
                    f"{i}.{c}" for i, c in enumerate(DEFAULT_CATEGORIES, 1)))
                cat = ask("Категорія (номер або назва)", "Інше")
                if cat.isdigit() and 1 <= int(cat) <= len(DEFAULT_CATEGORIES):
                    cat = DEFAULT_CATEGORIES[int(cat) - 1]
                note = ask("Примітка (необов'язково)")
                when = ask("Дата", date.today().isoformat())
                add_expense(data, amount, cat, note, when)
            elif choice == "2":
                list_expenses(data, parse_month(ask("Місяць (РРРР-ММ)", date.today().strftime("%Y-%m"))))
            elif choice == "3":
                report(data, parse_month(ask("Місяць (РРРР-ММ)", date.today().strftime("%Y-%m"))))
            elif choice == "4":
                set_budget(data, ask("Бюджет на місяць"))
            elif choice == "5":
                delete_expense(data, int(ask("Номер витрати (#)")))
            elif choice == "6":
                export_csv(data, parse_month(ask("Місяць (РРРР-ММ)", date.today().strftime("%Y-%m"))))
            elif choice in ("0", "q", "вихід"):
                print("До зустрічі! Нехай гроші будуть ОК 🙂")
                return
            else:
                print("Невідома дія, спробуйте ще раз.")
        except ValueError as err:
            print(f"✘ Помилка: {err}")


# ---------- Командний рядок ----------

def main(argv=None):
    parser = argparse.ArgumentParser(description="«Гроші ОК» — облік щомісячних витрат")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("add", help="додати витрату")
    p.add_argument("amount", help="сума, напр. 199.90")
    p.add_argument("category", nargs="?", default="Інше", help="категорія")
    p.add_argument("note", nargs="?", default="", help="примітка")
    p.add_argument("--date", help="дата (РРРР-ММ-ДД або ДД.ММ.РРРР), типово — сьогодні")

    for name, help_text in (("list", "список витрат за місяць"),
                            ("report", "звіт за місяць"),
                            ("export", "експорт місяця у CSV")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("month", nargs="?", help="місяць РРРР-ММ, типово — поточний")

    p = sub.add_parser("budget", help="встановити місячний бюджет")
    p.add_argument("amount")

    p = sub.add_parser("delete", help="видалити витрату за номером")
    p.add_argument("id", type=int)

    args = parser.parse_args(argv)
    data = load_data()

    try:
        if args.command is None:
            interactive(data)
        elif args.command == "add":
            add_expense(data, args.amount, args.category, args.note, args.date)
        elif args.command == "list":
            list_expenses(data, parse_month(args.month))
        elif args.command == "report":
            report(data, parse_month(args.month))
        elif args.command == "export":
            export_csv(data, parse_month(args.month))
        elif args.command == "budget":
            set_budget(data, args.amount)
        elif args.command == "delete":
            delete_expense(data, args.id)
    except ValueError as err:
        print(f"✘ Помилка: {err}")
        return 1
    except (KeyboardInterrupt, EOFError):
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
